import { beforeEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import { registerPushCommands } from '../../src/commands/push-commands';
import { SettingsStore } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import type { PushPrompts, PushReport, PushService } from '../../src/sync/push-service';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { err, ok, type Result } from '../../src/util/result';
import { App as FakeApp, Notice, Plugin as FakePlugin, TFile } from '../fakes/obsidian';

/**
 * The push commands (spec FR-5.1, FR-5.6, §6.1).
 *
 * Thin dispatch, so these tests are about dispatch: which pages a command decides
 * the user meant, and that a command exists at all only in the palette — nothing
 * here is wired to a save or a file event, which is FR-5.1's actual requirement.
 */

const MANIFEST = {
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
  mountPath: 'ENG',
  syncComments: true,
};

function emptyReport(extra: Partial<PushReport> = {}): PushReport {
  return { pushed: [], blocked: [], warnings: [], conflicts: [], skipped: 0, ...extra };
}

interface Recorded {
  readonly notes: string[];
  readonly subscriptions: string[];
}

let app: FakeApp;
let plugin: FakePlugin;
let settings: SettingsStore;
let recorded: Recorded;
let result: Result<PushReport, AppError>;

/** A push service that records what it was asked to do and answers with `result`. */
function fakePush(): PushService {
  return {
    pushNote: (notePath: string): Promise<Result<PushReport, AppError>> => {
      recorded.notes.push(notePath);
      return Promise.resolve(result);
    },
    pushSubscription: (subscription: Subscription): Promise<Result<PushReport, AppError>> => {
      recorded.subscriptions.push(subscription.spaceKey);
      return Promise.resolve(result);
    },
  } as unknown as PushService;
}

async function setUp(prompts: PushPrompts = {}): Promise<void> {
  app = new FakeApp();
  plugin = new FakePlugin(app, MANIFEST);
  recorded = { notes: [], subscriptions: [] };
  result = ok(emptyReport());
  Notice.reset();

  settings = new SettingsStore(plugin, new Logger('test', () => false));
  await settings.load();
  await settings.update({ subscriptions: [SUBSCRIPTION] });

  registerPushCommands({
    plugin: plugin as unknown as Plugin,
    store: settings,
    push: fakePush(),
    prompts: () => prompts,
  });
}

async function run(id: string): Promise<void> {
  const command = plugin.commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`no command ${id}`);
  command.callback?.();
  // The callbacks are fire-and-forget; two turns let the promise chain settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  await setUp();
});

describe('registration (FR-5.1, §7.4)', () => {
  it('registers both push commands with no default hotkey', () => {
    const ids = plugin.commands.map((command) => command.id);

    expect(ids).toContain('push-current-page');
    expect(ids).toContain('push-modified-pages');
    expect(plugin.commands.every((command) => !('hotkeys' in command))).toBe(true);
  });

  it('does not put the plugin name in a command title (§7.4)', () => {
    // Obsidian adds the prefix itself; repeating it reads as "Confluence 4
    // Obsidian: Confluence: push…".
    expect(plugin.commands.every((command) => !/confluence 4 obsidian/i.test(command.name))).toBe(
      true,
    );
  });
});

describe('pushing the active note', () => {
  it('pushes the note the user is looking at', async () => {
    app.workspace.activeFile = new TFile('ENG/Architecture.md');

    await run('push-current-page');

    expect(recorded.notes).toEqual(['ENG/Architecture.md']);
  });

  it('asks for a note first when nothing is open', async () => {
    await run('push-current-page');

    expect(recorded.notes).toEqual([]);
    expect(Notice.shown[0]).toContain('Open a Confluence note');
  });

  it('ignores a file that is not Markdown', async () => {
    app.workspace.activeFile = new TFile('ENG/_attachments/1/diagram.png');

    await run('push-current-page');

    expect(recorded.notes).toEqual([]);
  });

  it('surfaces the reason a push was refused', async () => {
    app.workspace.activeFile = new TFile('ENG/A.md');
    result = err(new AppError('OUT_OF_MOUNT', 'This note is not inside a subscription.'));

    await run('push-current-page');

    expect(Notice.shown[0]).toContain('not inside a subscription');
  });
});

describe('pushing everything modified', () => {
  it('goes through every subscription', async () => {
    await settings.update({ subscriptions: [SUBSCRIPTION, { ...SUBSCRIPTION, spaceKey: 'VOEN' }] });

    await run('push-modified-pages');

    expect(recorded.subscriptions).toEqual(['ENG', 'VOEN']);
  });

  it('says so when there is nothing subscribed', async () => {
    await settings.update({ subscriptions: [] });

    await run('push-modified-pages');

    expect(recorded.subscriptions).toEqual([]);
    expect(Notice.shown[0]).toContain('No Confluence subscriptions');
  });

  it('reports what happened, including that nothing did', async () => {
    // After a command that could publish to a corporate wiki, "nothing happened"
    // is information the user needs.
    await run('push-modified-pages');

    expect(Notice.shown[0]).toContain('0 pushed');
  });

  it('counts what was pushed, skipped, blocked and resolved', async () => {
    result = ok(
      emptyReport({
        pushed: [{ pageId: '1', title: 'A', path: 'ENG/A.md' }],
        skipped: 12,
        blocked: [
          {
            pageId: '2',
            title: 'B',
            path: 'ENG/B.md',
            error: new AppError('FIDELITY_DEGRADED', 'read-only'),
          },
        ],
        conflicts: [
          {
            pageId: '3',
            title: 'C',
            path: 'ENG/C.md',
            choice: 'keep-remote',
            state: null,
            copyPath: null,
            error: null,
            blocked: null,
          },
        ],
      }),
    );

    await run('push-modified-pages');

    const notice = Notice.shown[0] ?? '';
    expect(notice).toContain('1 pushed');
    expect(notice).toContain('12 unchanged');
    expect(notice).toContain('1 blocked');
    expect(notice).toContain('1 conflict(s) resolved');
    expect(notice).toContain('sync panel');
  });

  it('does not count a skipped conflict as resolved', async () => {
    result = ok(
      emptyReport({
        conflicts: [
          {
            pageId: '3',
            title: 'C',
            path: 'ENG/C.md',
            choice: 'skip',
            state: null,
            copyPath: null,
            error: null,
            blocked: null,
          },
        ],
      }),
    );

    await run('push-modified-pages');

    expect(Notice.shown[0]).not.toContain('resolved');
  });

  it('names the space when a whole subscription could not be pushed', async () => {
    result = err(new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.'));

    await run('push-modified-pages');

    expect(Notice.shown[0]).toContain('ENG:');
  });
});
