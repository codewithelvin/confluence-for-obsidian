import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';
import { registerCommands, type CommandDeps } from '../../src/commands/register-commands';
import { SettingsStore } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { CredentialStore } from '../../src/auth/credential-store';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncController } from '../../src/sync/sync-controller';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import { Logger } from '../../src/util/logger';
import type { ConfluenceClient } from '../../src/api/confluence-client';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';
import {
  App as FakeApp,
  Notice,
  Plugin as FakePlugin,
  TFile,
  type PluginManifest,
} from '../fakes/obsidian';

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
  spaceKey: 'ENG',
  rootPageId: null,
  mountPath: 'Confluence',
  syncComments: true,
};

let app: FakeApp;
let plugin: FakePlugin;
let settings: SettingsStore;
let controller: SyncController;
let client: FakeConfluence;
let vault: FakeVaultGateway;
let started: Subscription[];
let panelOpened: number;

async function setup(): Promise<void> {
  Notice.reset();
  app = new FakeApp();
  plugin = new FakePlugin(app, MANIFEST);
  const logger = new Logger('test', () => false);
  const stateGateway = new FakeStateGateway();
  vault = new FakeVaultGateway();
  client = new FakeConfluence();
  started = [];
  panelOpened = 0;

  settings = new SettingsStore(plugin, logger);
  await settings.load();
  await settings.update({
    connections: [{ id: 'conn', displayName: 'Corp wiki', baseUrl: 'https://wiki.corp' }],
  });

  controller = new SyncController({
    settings,
    vault,
    state: new SyncStateStore(stateGateway),
    fragments: new FragmentStore(stateGateway),
    suspensions: new SuspensionRegistry(),
    logger,
    newId: () => 'sub',
    createClient: () => client,
    now: () => '2026-08-10T12:00:00Z',
  });
  await controller.load();

  const deps: CommandDeps = {
    plugin: plugin as unknown as Plugin,
    store: settings,
    credentials: new CredentialStore(null, settings, logger),
    controller,
    createClient: (): ConfluenceClient => {
      throw new Error('no client should be created unless a command asks for one');
    },
    startSync: (subscription) => started.push(subscription),
    openSyncPanel: () => {
      panelOpened += 1;
    },
  };
  registerCommands(deps);
}

function run(id: string): void {
  const command = plugin.commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`no command ${id}`);
  command.callback?.();
}

/**
 * Waits for the promise a command kicked off without awaiting.
 *
 * Several ticks, not one: a pull hashes its output through `crypto.subtle`,
 * which is genuinely asynchronous, so a single macrotask is not enough.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 30; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function openNote(path: string): void {
  app.workspace.activeFile = new TFile(path);
}

beforeEach(async () => {
  await setup();
});

describe('command registration', () => {
  it('registers every M3 command in the palette (FR-10.4)', () => {
    expect(plugin.commands.map((command) => command.id).sort()).toEqual([
      'open-in-confluence',
      'open-sync-panel',
      'probe-conversion-fidelity',
      'pull-current-page',
      'sync-now',
    ]);
  });

  it('declares no default hotkeys (spec §7.4)', () => {
    for (const command of plugin.commands) {
      expect(command).not.toHaveProperty('hotkeys');
    }
  });

  it('leaves the plugin name out of command titles, since Obsidian adds it', () => {
    for (const command of plugin.commands) {
      expect(command.name.toLowerCase()).not.toContain('confluence 4 obsidian');
    }
  });
});

describe('sync all subscriptions (FR-3.1)', () => {
  it('says so when there is nothing subscribed', async () => {
    run('sync-now');
    await settle();

    expect(started).toHaveLength(0);
    expect(Notice.shown[0]).toContain('No Confluence subscriptions');
  });

  it('starts each subscription', async () => {
    await settings.update({ subscriptions: [SUBSCRIPTION, { ...SUBSCRIPTION, id: 'sub-2' }] });

    run('sync-now');
    await settle();

    expect(started.map((subscription) => subscription.id)).toEqual(['sub', 'sub-2']);
  });
});

describe('pull this page (FR-3.8)', () => {
  it('asks for a note first', async () => {
    run('pull-current-page');
    await settle();

    expect(Notice.shown[0]).toContain('Open a Confluence note first');
  });

  it('ignores a file that is not Markdown', async () => {
    openNote('Confluence/ENG/diagram.png');

    run('pull-current-page');
    await settle();

    expect(Notice.shown[0]).toContain('Open a Confluence note first');
  });

  it('reports why a note outside a subscription cannot be pulled', async () => {
    openNote('Personal/thoughts.md');

    run('pull-current-page');
    await settle();

    expect(Notice.shown[0]).toContain('not inside a Confluence subscription');
  });

  it('pulls the active note and names the page', async () => {
    await settings.update({ subscriptions: [SUBSCRIPTION] });
    client.pages = [{ id: '1', title: 'Architecture' }];
    await controller.sync(SUBSCRIPTION);
    Notice.reset();
    openNote('Confluence/ENG/Architecture.md');

    run('pull-current-page');
    await settle();

    expect(Notice.shown[0]).toContain('Architecture');
  });
});

describe('open in Confluence (FR-10.5)', () => {
  it('opens the URL recorded in the note', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await settings.update({ subscriptions: [SUBSCRIPTION] });
    client.pages = [{ id: '1', title: 'A' }];
    await controller.sync(SUBSCRIPTION);
    openNote('Confluence/ENG/A.md');

    run('open-in-confluence');

    expect(open).toHaveBeenCalledWith('https://wiki.corp/pages/viewpage.action?pageId=1', '_blank');
    vi.unstubAllGlobals();
  });

  it('says so when the note has no page recorded', () => {
    openNote('Personal/thoughts.md');

    run('open-in-confluence');

    expect(Notice.shown[0]).toContain('no Confluence page recorded');
  });
});

describe('sync panel and diagnostics', () => {
  it('opens the sync panel', () => {
    run('open-sync-panel');
    expect(panelOpened).toBe(1);
  });

  it('refuses the fidelity probe until a token is stored', async () => {
    run('probe-conversion-fidelity');
    await settle();

    // `createClient` throws if called, so this also proves no client was built.
    expect(Notice.shown[0]).toContain('connection with a token');
  });
});
