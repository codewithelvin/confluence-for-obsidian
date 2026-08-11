import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, type SettingsPersistence } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { PageStructureService } from '../../src/sync/page-structure-service';
import { SyncStateStore } from '../../src/sync/sync-state';
import type { PageState } from '../../src/sync/sync-state';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * Creating, publishing and deleting one page (spec FR-7.1 to FR-7.4, US-7, US-8).
 *
 * None of these is ever reached by a sync. That is D6 and FR-5.1 in force, and the
 * assertions keep it honest: `client.created` and `client.deleted` are the record of
 * what the user's own command did, and nothing else may add to them.
 */

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'EP',
  rootPageId: 'root',
  mountPath: 'EP',
  syncComments: true,
};

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let state: SyncStateStore;
let client: FakeConfluence;
let service: PageStructureService;

function tracked(extra: Partial<PageState> & { pageId: string }): PageState {
  return {
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

/** A settings store over in-memory persistence, seeded with one connection and mount. */
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

async function seedSettings(store: SettingsStore): Promise<void> {
  await store.load();
  await store.update({
    connections: [
      { id: 'conn', displayName: 'Corp', baseUrl: 'https://wiki.corp', strictMarkup: false },
    ],
    subscriptions: [SUBSCRIPTION],
  });
}

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  client.spaceKey = 'EP';
  client.homepageId = 'root';
  client.pages = [
    { id: 'root', title: 'E-Portal home' },
    { id: '1', title: 'Architecture', parentId: 'root' },
    { id: '2', title: 'Design', parentId: 'root' },
  ];

  const settings = settingsStore();
  await seedSettings(settings);
  await state.load();
  await state.replace('sub', {
    lastSyncedAt: null,
    pages: {
      root: tracked({
        pageId: 'root',
        title: 'E-Portal home',
        parentId: null,
        localPath: 'EP/EP.md',
        isFolderNote: true,
      }),
      '1': tracked({ pageId: '1' }),
      '2': tracked({
        pageId: '2',
        title: 'Design',
        localPath: 'EP/Design/Design.md',
        isFolderNote: true,
      }),
    },
  });

  vault.files.set('EP/EP.md', '---\nconfluence:\n  id: root\n---\nhome');
  vault.files.set('EP/Architecture.md', '---\nconfluence:\n  id: 1\n---\nbody');
  vault.files.set('EP/Design/Design.md', '---\nconfluence:\n  id: 2\n---\nbody');
  for (const [path, id] of [
    ['EP/EP.md', 'root'],
    ['EP/Architecture.md', '1'],
    ['EP/Design/Design.md', '2'],
  ] as const) {
    vault.identities.set(path, {
      id,
      space: 'EP',
      version: 1,
      parent: null,
      url: '',
      updated: '',
      updatedBy: '',
      fidelity: 'certified',
    });
  }

  service = new PageStructureService({
    settings,
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    logger: new Logger('test', () => false),
    createClient: () => client,
    now: () => '2026-08-11T09:00:00Z',
  });
});

describe('creating a page (FR-7.1, US-7)', () => {
  it('creates it under the chosen parent and writes a tracked note', async () => {
    const created = await service.createPage({
      subscription: SUBSCRIPTION,
      title: 'API Gateway',
      parentId: '2',
    });

    expect(created.ok).toBe(true);
    expect(client.created[0]).toMatchObject({
      title: 'API Gateway',
      parentId: '2',
      spaceKey: 'EP',
    });
    // Written beside its parent's note, and tracked from the first moment.
    expect(created.ok && created.value.localPath).toBe('EP/Design/API Gateway.md');
    expect(vault.identities.has('EP/Design/API Gateway.md')).toBe(true);
  });

  it('puts a top-level page under the root page, not at the top of the space (D13)', async () => {
    const created = await service.createPage({
      subscription: SUBSCRIPTION,
      title: 'Glossary',
      parentId: null,
    });

    expect(client.created[0]?.parentId).toBe('root');
    expect(created.ok && created.value.localPath).toBe('EP/Glossary.md');
  });

  it('promotes a leaf parent to a folder note first (§6.5.4)', async () => {
    // A page cannot have a child while it is a single file. The note is moved with
    // `renameFile` so every wikilink pointing at it is rewritten by Obsidian.
    const created = await service.createPage({
      subscription: SUBSCRIPTION,
      title: 'Sequence',
      parentId: '1',
    });

    expect(vault.moves).toEqual([
      { from: 'EP/Architecture.md', to: 'EP/Architecture/Architecture.md' },
    ]);
    expect(state.forSubscription('sub').pages['1']?.isFolderNote).toBe(true);
    expect(created.ok && created.value.localPath).toBe('EP/Architecture/Sequence.md');
  });

  it('sanitises a title that is not a legal file name', async () => {
    const created = await service.createPage({
      subscription: SUBSCRIPTION,
      title: 'Q1/Q2 review',
      parentId: null,
    });

    // The page keeps the title the user asked for; only the file name is adjusted.
    expect(client.created[0]?.title).toBe('Q1/Q2 review');
    expect(created.ok && created.value.localPath).not.toContain('Q1/Q2');
  });

  it('writes nothing locally when Confluence refuses', async () => {
    client.createError = new AppError('PERMISSION_DENIED', 'no permission in this space');

    const created = await service.createPage({
      subscription: SUBSCRIPTION,
      title: 'API Gateway',
      parentId: '2',
    });

    expect(created.ok).toBe(false);
    expect(vault.files.has('EP/Design/API Gateway.md')).toBe(false);
  });
});

describe('publishing a note the user wrote (FR-7.2, US-7)', () => {
  it('creates the page from the note’s own body and tracks the note', async () => {
    vault.files.set('EP/Design/Notes.md', 'Some prose I wrote.\n');

    const created = await service.promoteNote('EP/Design/Notes.md');

    expect(created.ok).toBe(true);
    expect(client.created[0]).toMatchObject({ title: 'Notes', parentId: '2' });
    expect(client.created[0]?.storage).toContain('Some prose I wrote.');
  });

  it('refuses a note that is already a Confluence page', async () => {
    const created = await service.promoteNote('EP/Architecture.md');

    expect(created.ok).toBe(false);
    expect(client.created).toEqual([]);
  });

  it('refuses a note outside every mount', async () => {
    vault.files.set('Personal/Notes.md', 'Mine.');

    const created = await service.promoteNote('Personal/Notes.md');

    expect(!created.ok && created.error.code).toBe('OUT_OF_MOUNT');
    expect(client.created).toEqual([]);
  });

  it('refuses a folder that is not a page, rather than guessing a parent', async () => {
    vault.files.set('EP/My Notes/Notes.md', 'Mine.');

    const created = await service.promoteNote('EP/My Notes/Notes.md');

    expect(!created.ok && created.error.code).toBe('NOT_FOUND');
    expect(client.created).toEqual([]);
  });

  it('refuses a note whose Markdown cannot survive the round trip', async () => {
    // An embed is the realistic case: the page has no attachment of that name, so the
    // embed can only go across as literal text, and the round trip does not close.
    // Better to be told no than to be handed a page that is read-only from the moment
    // it is created — FR-5.3 would then keep it that way.
    vault.files.set('EP/Design/Notes.md', 'Prose.\n\n![[diagram.png]]\n');

    const created = await service.promoteNote('EP/Design/Notes.md');

    expect(created.ok).toBe(false);
    expect(!created.ok && created.error.code).toBe('VERIFICATION_FAILED');
    expect(client.created).toEqual([]);
  });
});

describe('deleting a page (FR-7.3, US-8)', () => {
  it('trashes the page, then the note, and forgets the record', async () => {
    const deleted = await service.deletePage('EP/Architecture.md');

    expect(deleted.ok).toBe(true);
    expect(client.deleted).toEqual(['1']);
    expect(vault.trashed).toContain('EP/Architecture.md');
    expect(state.forSubscription('sub').pages['1']).toBeUndefined();
  });

  it('keeps the note when Confluence refuses the delete', async () => {
    // The remote call goes first for exactly this reason: a note removed beside a page
    // that is still there would be a mirror tracking something it cannot see.
    client.deleteError = new AppError('PERMISSION_DENIED', 'not allowed');

    const deleted = await service.deletePage('EP/Architecture.md');

    expect(deleted.ok).toBe(false);
    expect(vault.trashed).toEqual([]);
    expect(state.forSubscription('sub').pages['1']).toBeDefined();
  });

  it('refuses a note with no Confluence page behind it', async () => {
    vault.files.set('EP/Design/Notes.md', 'Mine.');

    const deleted = await service.deletePage('EP/Design/Notes.md');

    expect(deleted.ok).toBe(false);
    expect(client.deleted).toEqual([]);
  });

  it('deletes the page behind an orphan, which has no note left to remove (FR-7.4)', async () => {
    const deleted = await service.deleteOrphan(SUBSCRIPTION, '1');

    expect(deleted.ok).toBe(true);
    expect(client.deleted).toEqual(['1']);
    expect(state.forSubscription('sub').pages['1']).toBeUndefined();
  });
});

describe('the parent picker (FR-7.1)', () => {
  it('offers the mount first, then every mirrored page by path', () => {
    // Only mirrored pages: a page with no note has nowhere in the vault for a child
    // to be written to.
    const choices = service.parentChoices(SUBSCRIPTION);

    expect(choices[0]?.pageId).toBeNull();
    expect(choices.slice(1).map((choice) => choice.path)).toEqual([
      'EP/Architecture.md',
      'EP/Design/Design.md',
      'EP/EP.md',
    ]);
  });
});
