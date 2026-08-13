import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsPersistence } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { NoteService, isFolderNotePath } from '../../src/sync/note-service';
import { SyncStateStore, type PageState } from '../../src/sync/sync-state';
import { AppError } from '../../src/util/errors';
import { sha256 } from '../../src/util/hash';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * What the plugin can do with one note (spec FR-3.8, FR-4.5, FR-7.4, FR-10.5).
 *
 * The single-page pull is the command a user reaches for *while editing*, which is
 * why the backup rule matters more here than anywhere else: it is the one
 * destructive local write nobody expects to be destructive.
 */

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'EP',
  rootPageId: 'root',
  mountPath: 'EP',
  syncComments: true,
};

const IDENTITY = {
  id: '1',
  space: 'EP',
  version: 1,
  parent: null,
  url: 'https://wiki.corp/pages/viewpage.action?pageId=1',
  updated: '2026-08-10T12:00:00Z',
  updatedBy: 'j.smith',
  fidelity: 'certified' as const,
};

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let state: SyncStateStore;
let client: FakeConfluence;
let service: NoteService;

function tracked(extra: Partial<PageState> = {}): PageState {
  return {
    pageId: '1',
    title: 'Architecture',
    parentId: 'root',
    remoteVersion: 1,
    localPath: 'EP/Architecture.md',
    isFolderNote: false,
    alias: null,
    attachments: {},
    labels: [],
    localHash: 'hash',
    storageHash: 'storage',
    fidelity: 'certified',
    lastSyncedAt: '2026-08-10T12:00:00Z',
    ...extra,
  };
}

function settingsStore(): SettingsStore {
  let stored: unknown = null;
  const persistence: SettingsPersistence = {
    loadData: () => Promise.resolve(stored),
    saveData: (data: unknown) => {
      stored = data;
      return Promise.resolve();
    },
  };
  return new SettingsStore(persistence, new Logger('test', () => false));
}

/** Every file the backup store wrote, which lives in the plugin state directory. */
function backups(): string[] {
  return [...stateGateway.files.keys()].filter((name) => name.includes('backup'));
}

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  client.pages = [{ id: '1', title: 'Architecture', parentId: 'root', storage: '<p>Fresh.</p>' }];

  const settings = settingsStore();
  await settings.load();
  await settings.update({
    connections: [
      { id: 'conn', displayName: 'Corp', baseUrl: 'https://wiki.corp', strictMarkup: false },
    ],
    subscriptions: [SUBSCRIPTION],
  });
  await state.load();
  await state.replace('sub', { lastSyncedAt: null, pages: { '1': tracked() } });

  vault.files.set('EP/Architecture.md', 'body');
  vault.identities.set('EP/Architecture.md', IDENTITY);

  service = new NoteService({
    settings,
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    logger: new Logger('test', () => false),
    createClient: () => client,
    now: () => '2026-08-12T00:00:00Z',
  });
});

describe('reading a note', () => {
  it('finds the subscription a note belongs to, and none for a personal note', () => {
    expect(service.subscriptionFor('EP/Architecture.md')?.id).toBe('sub');
    expect(service.subscriptionFor('Personal/Diary.md')).toBeNull();
  });

  it('gives the page URL from frontmatter, and nothing without one', () => {
    expect(service.pageUrlFor('EP/Architecture.md')).toBe(IDENTITY.url);
    expect(service.pageUrlFor('Personal/Diary.md')).toBeNull();
  });

  it('treats an empty URL as no URL', () => {
    vault.identities.set('EP/Architecture.md', { ...IDENTITY, url: '' });

    expect(service.pageUrlFor('EP/Architecture.md')).toBeNull();
  });

  it('answers with no fragments for a note the plugin does not own', async () => {
    expect(await service.fragmentsFor('Personal/Diary.md')).toEqual(new Map());
  });

  it('answers with no fragments when the sidecar was never written', async () => {
    expect(await service.fragmentsFor('EP/Architecture.md')).toEqual(new Map());
  });

  it('recognises the folder-note shape', () => {
    expect(isFolderNotePath('EP/Design/Design.md')).toBe(true);
    expect(isFolderNotePath('EP/Design/Schema.md')).toBe(false);
  });
});

describe('pulling one page (FR-3.8)', () => {
  it('writes the page back and records it', async () => {
    const pulled = await service.pullPage('EP/Architecture.md');

    expect(pulled.ok && pulled.value.state.remoteVersion).toBe(1);
    expect(vault.writes).toContain('EP/Architecture.md');
    expect(state.forSubscription('sub').pages['1']?.localHash).not.toBe('hash');
  });

  it('reports an attachment Confluence does not have (FR-8.9)', async () => {
    // This path has no sync report to put the answer in, and it is the one a user
    // reaches for when a picture is missing — so the answer travels with the state.
    // Collecting it and dropping it left the command unable to explain itself.
    client.pages = [
      {
        id: '1',
        title: 'Architecture',
        parentId: 'root',
        storage: '<p><ac:image><ri:attachment ri:filename="gone.png"/></ac:image></p>',
      },
    ];

    const pulled = await service.pullPage('EP/Architecture.md');

    expect(pulled.ok && pulled.value.skippedAttachments).toEqual([
      {
        pageId: '1',
        filename: 'gone.png',
        reason: 'referenced by the page, but Confluence does not have it',
      },
    ]);
  });

  it('reports nothing skipped when the body names no attachment', async () => {
    const pulled = await service.pullPage('EP/Architecture.md');
    expect(pulled.ok && pulled.value.skippedAttachments).toEqual([]);
  });

  it('backs the note up first, because a re-pull discards local edits (FR-6.6)', async () => {
    // The note on disk does not hash to what the index recorded, so it holds work
    // the pull is about to overwrite.
    const pulled = await service.pullPage('EP/Architecture.md');

    expect(pulled.ok).toBe(true);
    expect(backups()).toHaveLength(1);
  });

  it('does not back up a note that has not been touched', async () => {
    const current = state.forSubscription('sub');
    await state.replace('sub', {
      ...current,
      pages: { '1': tracked({ localHash: await sha256('body') }) },
    });

    await service.pullPage('EP/Architecture.md');

    expect(backups()).toHaveLength(0);
  });

  it('cancels the pull when the backup cannot be written (FR-6.6)', async () => {
    stateGateway.failWrites = true;

    const pulled = await service.pullPage('EP/Architecture.md');

    expect(pulled.ok).toBe(false);
    expect(vault.writes).not.toContain('EP/Architecture.md');
  });

  it('refuses a note outside every subscription', async () => {
    const pulled = await service.pullPage('Personal/Diary.md');

    expect(!pulled.ok && pulled.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports a page Confluence would not give back', async () => {
    client.failGetPage.add('1');

    const pulled = await service.pullPage('EP/Architecture.md');

    expect(pulled.ok).toBe(false);
  });
});

describe('restoring an orphan (FR-7.4)', () => {
  beforeEach(() => {
    // An orphan is a page whose note is gone; there is nothing on disk to read.
    vault.files.delete('EP/Architecture.md');
    vault.identities.delete('EP/Architecture.md');
  });

  it('writes the note back where the index remembers it', async () => {
    const restored = await service.restoreOrphan(SUBSCRIPTION, '1');

    expect(restored.ok && restored.value.localPath).toBe('EP/Architecture.md');
    expect(vault.files.has('EP/Architecture.md')).toBe(true);
    expect(backups()).toHaveLength(0);
  });

  it('keeps the recorded folder-note shape and alias', async () => {
    await state.replace('sub', {
      lastSyncedAt: null,
      pages: {
        '1': tracked({
          localPath: 'EP/Architecture/Architecture.md',
          isFolderNote: true,
          alias: 'Architecture & design',
        }),
      },
    });

    const restored = await service.restoreOrphan(SUBSCRIPTION, '1');

    expect(restored.ok && restored.value.isFolderNote).toBe(true);
    expect(vault.files.has('EP/Architecture/Architecture.md')).toBe(true);
  });

  it('refuses when the subscription points at a connection that is gone', async () => {
    const restored = await service.restoreOrphan({ ...SUBSCRIPTION, connectionId: 'missing' }, '1');

    expect(!restored.ok && restored.error.code).toBe('CREDENTIALS_UNAVAILABLE');
  });

  it('refuses a page the index has forgotten', async () => {
    await state.replace('sub', { lastSyncedAt: null, pages: {} });

    const restored = await service.restoreOrphan(SUBSCRIPTION, '1');

    expect(!restored.ok && restored.error.code).toBe('NOT_FOUND');
  });

  it('reports a page Confluence would not give back', async () => {
    client.failGetPage.add('1');

    const restored = await service.restoreOrphan(SUBSCRIPTION, '1');

    expect(restored.ok).toBe(false);
    expect(restored.ok || restored.error instanceof AppError).toBe(true);
  });
});
