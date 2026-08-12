import { beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import { registerStructureCommands } from '../../src/commands/structure-commands';
import { SettingsStore, type SettingsPersistence } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { PageStructureService } from '../../src/sync/page-structure-service';
import { SyncStateStore, type PageState } from '../../src/sync/sync-state';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';
import {
  App as FakeApp,
  Modal,
  Notice,
  Plugin as FakePlugin,
  TFile,
  type PluginManifest,
} from '../fakes/obsidian';

/**
 * The structural commands as the user meets them (spec FR-7.1 to FR-7.3, §6.5.4).
 *
 * Dispatch only — the decisions belong to `PageStructureService`, which its own
 * tests cover. What is asserted here is the part a user can see: which commands
 * exist, that `Tidy folder notes` shows the whole list before moving anything
 * (FR-7.8), and that declining moves nothing.
 */

const MANIFEST: PluginManifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence 4 Obsidian',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
};

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'EP',
  rootPageId: 'root',
  mountPath: 'EP',
  syncComments: true,
};

let app: FakeApp;
let plugin: FakePlugin;
let vault: FakeVaultGateway;
let state: SyncStateStore;
let settings: SettingsStore;
let client: FakeConfluence;
let opened: string[];

function tracked(extra: Partial<PageState> & { pageId: string }): PageState {
  return {
    title: 'Design',
    parentId: 'root',
    remoteVersion: 1,
    localPath: 'EP/Design/Design.md',
    isFolderNote: true,
    alias: null,
    attachments: {},
    labels: [],
    localHash: 'hash',
    storageHash: 'storage',
    fidelity: 'certified',
    lastSyncedAt: '2026-08-11T12:00:00Z',
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

/** Runs a registered command by id. */
function run(id: string): void {
  const command = plugin.commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`no command "${id}"`);
  command.callback?.();
}

/** Clicks a button in the most recently opened modal. */
function answer(label: string): void {
  const modal = Modal.opened.at(-1);
  if (modal === undefined) throw new Error('no modal was opened');

  const button = Array.from(modal.contentEl.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  button.dispatchEvent(new Event('click'));
}

/**
 * Lets a fire-and-forget command callback finish.
 *
 * Several macrotasks rather than one: publishing a note runs a create, a pull and a
 * state write, each with its own await, before the notice is shown.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  Notice.reset();
  Modal.reset();

  app = new FakeApp();
  plugin = new FakePlugin(app, MANIFEST);
  const stateGateway = new FakeStateGateway();
  vault = new FakeVaultGateway();
  state = new SyncStateStore(stateGateway);
  settings = settingsStore();
  client = new FakeConfluence();
  client.pages = [{ id: 'root', title: 'Home' }];
  opened = [];

  await settings.load();
  await settings.update({
    connections: [
      { id: 'conn', displayName: 'Corp', baseUrl: 'https://wiki.corp', strictMarkup: false },
    ],
    subscriptions: [SUBSCRIPTION],
  });
  await state.load();

  registerStructureCommands({
    plugin: plugin as unknown as Plugin,
    store: settings,
    pages: new PageStructureService({
      settings,
      vault,
      state,
      fragments: new FragmentStore(stateGateway),
      backups: fakeBackups(stateGateway),
      logger: new Logger('test', () => false),
      createClient: () => client,
      now: () => '2026-08-12T00:00:00Z',
    }),
    openNote: (path) => opened.push(path),
  });
});

/** Seeds one childless folder note, ready to be tidied. */
async function seedTidyable(): Promise<void> {
  await state.replace('sub', {
    lastSyncedAt: null,
    pages: { '2': tracked({ pageId: '2' }) },
  });
  vault.files.set('EP/Design/Design.md', 'body');
  vault.folders.add('EP/Design');
}

describe('command registration', () => {
  it('registers every structural command, tidy included', () => {
    expect(plugin.commands.map((command) => command.id).sort()).toEqual([
      'create-confluence-page',
      'delete-confluence-page',
      'publish-note-as-page',
      'tidy-folder-notes',
    ]);
  });

  it('declares no default hotkeys (spec §7.4)', () => {
    for (const command of plugin.commands) {
      expect(command).not.toHaveProperty('hotkeys');
    }
  });
});

describe('create, publish and delete (FR-7.1 to FR-7.3)', () => {
  it('opens the picker rather than creating anything outright', () => {
    run('create-confluence-page');

    expect(Modal.opened).toHaveLength(1);
    expect(client.created).toHaveLength(0);
  });

  it('asks for a note before publishing one', async () => {
    run('publish-note-as-page');
    await settle();

    expect(Notice.shown.at(-1)).toContain('Open the note you want to publish');
    expect(client.created).toHaveLength(0);
  });

  it('publishes the note the user is looking at', async () => {
    await state.replace('sub', {
      lastSyncedAt: null,
      pages: {
        root: tracked({ pageId: 'root', title: 'Home', localPath: 'EP/EP.md', parentId: null }),
      },
    });
    vault.files.set('EP/Draft.md', 'Some prose.');
    app.workspace.activeFile = new TFile('EP/Draft.md');

    run('publish-note-as-page');
    await settle();

    expect(client.created.map((page) => page.title)).toEqual(['Draft']);
    expect(Notice.shown.at(-1)).toContain('Published');
  });

  it('asks for a note before deleting a page', () => {
    run('delete-confluence-page');

    expect(Modal.opened).toHaveLength(0);
    expect(Notice.shown.at(-1)).toContain('Open the Confluence note');
  });

  it('demands the exact title typed before deleting (FR-7.3)', async () => {
    await state.replace('sub', { lastSyncedAt: null, pages: { '2': tracked({ pageId: '2' }) } });
    vault.files.set('EP/Design/Design.md', 'body');
    vault.identities.set('EP/Design/Design.md', {
      id: '2',
      space: 'EP',
      version: 1,
      parent: null,
      url: '',
      updated: '',
      updatedBy: '',
      fidelity: 'certified',
    });
    app.workspace.activeFile = new TFile('EP/Design/Design.md');

    run('delete-confluence-page');
    const modal = Modal.opened.at(-1);
    if (modal === undefined) throw new Error('no confirmation was shown');

    // The wrong phrase does nothing at all — that friction is the whole point.
    answer('Delete in Confluence');
    await settle();
    expect(client.deleted).toHaveLength(0);

    const input = modal.contentEl.querySelector('input');
    if (input === null) throw new Error('no confirmation field');
    input.value = 'Design';
    input.dispatchEvent(new Event('input'));

    answer('Delete in Confluence');
    await settle();
    expect(client.deleted).toEqual(['2']);
  });
});

describe('tidy folder notes (§6.5.4)', () => {
  it('says so when there is nothing to tidy, and opens no modal', () => {
    run('tidy-folder-notes');

    expect(Modal.opened).toHaveLength(0);
    expect(Notice.shown[0]).toContain('Nothing to tidy');
  });

  it('names the blocker when every candidate is refused', async () => {
    await seedTidyable();
    vault.files.set('EP/Design.md', 'someone else');

    run('tidy-folder-notes');

    expect(Modal.opened).toHaveLength(0);
    expect(Notice.shown[0]).toContain('already exists');
  });

  it('previews the whole list and moves nothing until it is confirmed', async () => {
    await seedTidyable();

    run('tidy-folder-notes');
    expect(Modal.opened.at(-1)?.contentEl.querySelectorAll('li')).toHaveLength(1);
    expect(vault.moves).toEqual([]);

    answer('Not now');
    await settle();
    expect(vault.moves).toEqual([]);
  });

  it('demotes on confirmation and reports what it did', async () => {
    await seedTidyable();

    run('tidy-folder-notes');
    answer('Tidy them');
    await settle();

    expect(vault.moves).toEqual([{ from: 'EP/Design/Design.md', to: 'EP/Design.md' }]);
    expect(state.forSubscription('sub').pages['2']?.isFolderNote).toBe(false);
    expect(Notice.shown.at(-1)).toContain('Tidied 1 folder note(s).');
  });

  it('counts the ones it could not tidy alongside the ones it did', async () => {
    await state.replace('sub', {
      lastSyncedAt: null,
      pages: {
        '2': tracked({ pageId: '2' }),
        '3': tracked({ pageId: '3', title: 'Ops', localPath: 'EP/Ops/Ops.md' }),
      },
    });
    vault.files.set('EP/Design/Design.md', 'body');
    vault.files.set('EP/Ops/Ops.md', 'body');
    vault.files.set('EP/Ops.md', 'in the way');

    run('tidy-folder-notes');
    answer('Tidy them');
    await settle();

    expect(vault.moves).toHaveLength(1);
    expect(Notice.shown.at(-1)).toContain('1 could not be tidied');
  });
});
