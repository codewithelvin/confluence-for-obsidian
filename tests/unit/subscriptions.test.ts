import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/settings/settings-store';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncController } from '../../src/sync/sync-controller';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import { checkSubscriptionTarget } from '../../src/sync/subscription-service';
import {
  normaliseMountPath,
  sizeWarning,
  validateSubscription,
  type SubscriptionDraft,
} from '../../src/sync/subscription-validator';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';
import { App as FakeApp, Plugin as FakePlugin, type PluginManifest } from '../fakes/obsidian';

const DRAFT: SubscriptionDraft = {
  connectionId: 'conn',
  spaceKey: 'ENG',
  rootPageId: null,
  mountPath: 'ENG',
};

function subscription(id: string, mountPath: string, spaceKey = 'OPS'): Subscription {
  return { id, connectionId: 'conn', spaceKey, rootPageId: null, mountPath, syncComments: true };
}

describe('normaliseMountPath', () => {
  it('accepts an ordinary folder', () => {
    expect(normaliseMountPath('Confluence/ENG')).toBe('Confluence/ENG');
  });

  it('accepts a path pasted from Windows Explorer', () => {
    expect(normaliseMountPath('Confluence\\ENG')).toBe('Confluence/ENG');
  });

  it('strips stray separators and whitespace', () => {
    expect(normaliseMountPath('  /Confluence//ENG/ ')).toBe('Confluence/ENG');
  });

  it('refuses to let a mount climb out of the vault', () => {
    // Containment is the invariant the whole vault gateway rests on.
    expect(normaliseMountPath('../../etc')).toBe('etc');
    expect(normaliseMountPath('./Confluence')).toBe('Confluence');
  });
});

describe('validateSubscription', () => {
  it('accepts a well-formed draft', () => {
    expect(validateSubscription(DRAFT, [])).toBeNull();
  });

  it('requires a connection and a space', () => {
    expect(validateSubscription({ ...DRAFT, connectionId: '' }, [])?.code).toBe('INVALID_BASE_URL');
    expect(validateSubscription({ ...DRAFT, spaceKey: '  ' }, [])?.code).toBe('NOT_FOUND');
  });

  it('requires a folder inside the vault', () => {
    expect(validateSubscription({ ...DRAFT, mountPath: '  ' }, [])?.code).toBe('OUT_OF_MOUNT');
    expect(validateSubscription({ ...DRAFT, mountPath: '..' }, [])?.code).toBe('OUT_OF_MOUNT');
  });

  it('rejects a mount that overlaps another subscription (FR-2.5)', () => {
    const existing = [subscription('other', 'ENG')];

    expect(validateSubscription(DRAFT, existing)?.code).toBe('OUT_OF_MOUNT');
    expect(validateSubscription({ ...DRAFT, mountPath: 'ENG/Sub' }, existing)).not.toBeNull();
  });

  it('names the subscription in the way, so the message is actionable', () => {
    const error = validateSubscription(DRAFT, [subscription('other', 'ENG', 'OPS')]);
    expect(error?.userMessage).toContain('OPS');
  });

  it('allows a subscription alongside an unrelated one (FR-2.7)', () => {
    expect(validateSubscription(DRAFT, [subscription('other', 'Wiki')])).toBeNull();
  });

  it('lets a subscription keep its own mount while being edited', () => {
    const existing = [subscription('self', 'ENG')];
    expect(validateSubscription(DRAFT, existing, 'self')).toBeNull();
  });
});

describe('sizeWarning', () => {
  it('stays quiet below the threshold', () => {
    expect(sizeWarning(500, 1000)).toBeNull();
    expect(sizeWarning(1000, 1000)).toBeNull();
  });

  it('warns above it, naming the number of pages', () => {
    expect(sizeWarning(2400, 1000)?.message).toContain('2400');
  });

  it('treats an unreported total as unknown, not as zero', () => {
    expect(sizeWarning(null, 1000)).toBeNull();
  });
});

describe('checkSubscriptionTarget', () => {
  let client: FakeConfluence;

  beforeEach(() => {
    client = new FakeConfluence();
  });

  it('returns the page count for a supported instance', async () => {
    client.pages = [{ id: '1', title: 'A' }];
    const result = await checkSubscriptionTarget(client, DRAFT, 1000);

    expect(result.ok && result.value.pageCount).toBe(1);
    expect(result.ok && result.value.warning).toBeNull();
  });

  it('blocks a server older than 7.9 (spec FR-1.7)', async () => {
    client.versionSupported = false;
    const result = await checkSubscriptionTarget(client, DRAFT, 1000);

    expect(!result.ok && result.error.code).toBe('VERSION_UNSUPPORTED');
  });

  it('passes an authentication failure straight through', async () => {
    client.connectionError = new AppError('AUTH_FAILED', 'nope');
    const result = await checkSubscriptionTarget(client, DRAFT, 1000);

    expect(!result.ok && result.error.code).toBe('AUTH_FAILED');
  });

  it('warns about a large subtree (spec FR-2.4)', async () => {
    client.pages = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      title: `P${String(index)}`,
    }));

    const result = await checkSubscriptionTarget(client, DRAFT, 2);
    expect(result.ok && result.value.warning?.pageCount).toBe(5);
  });
});

const MANIFEST: PluginManifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence 4 Obsidian',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
};

describe('SyncController', () => {
  let vault: FakeVaultGateway;
  let settings: SettingsStore;
  let client: FakeConfluence;
  let controller: SyncController;

  beforeEach(async () => {
    const logger = new Logger('test', () => false);
    const stateGateway = new FakeStateGateway();
    vault = new FakeVaultGateway();
    client = new FakeConfluence();
    settings = new SettingsStore(new FakePlugin(new FakeApp(), MANIFEST), logger);
    await settings.load();
    await settings.update({
      connections: [
        { id: 'conn', displayName: 'Corp wiki', baseUrl: 'https://wiki.corp', strictMarkup: false },
      ],
    });

    controller = new SyncController({
      settings,
      vault,
      state: new SyncStateStore(stateGateway),
      fragments: new FragmentStore(stateGateway),
      suspensions: new SuspensionRegistry(),
      logger,
      newId: () => 'sub-1',
      createClient: () => client,
      now: () => '2026-08-10T12:00:00Z',
    });
    await controller.load();
  });

  it('creates a subscription from a draft', async () => {
    const created = await controller.create(DRAFT);

    expect(created.id).toBe('sub-1');
    expect(settings.get().subscriptions).toHaveLength(1);
  });

  it('refuses a second sync while one is running', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];

    const first = controller.sync(created);
    const second = await controller.sync(created);

    expect(!second.ok && second.error.userMessage).toContain('already running');
    expect((await first).ok).toBe(true);
  });

  it('reports a subscription whose connection was deleted', async () => {
    const created = await controller.create(DRAFT);
    await settings.update({ connections: [] });

    const result = await controller.sync(created);
    expect(!result.ok && result.error.code).toBe('CREDENTIALS_UNAVAILABLE');
  });

  it('keeps the notes when a subscription is detached (FR-2.6)', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];
    await controller.sync(created);

    await controller.remove(created, false);

    expect(vault.files.has('ENG/A.md')).toBe(true);
    expect(vault.trashed).toHaveLength(0);
    expect(settings.get().subscriptions).toHaveLength(0);
  });

  it('trashes the mirrored folder when asked to delete (FR-2.6)', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];
    await controller.sync(created);

    await controller.remove(created, true);

    expect(vault.trashed).toEqual(['ENG']);
    expect(controller.lastSyncedAt(created.id)).toBeNull();
  });

  it('reports a failure to delete rather than losing the subscription silently', async () => {
    const created = await controller.create(DRAFT);
    Object.defineProperty(vault, 'trash', {
      value: () => Promise.resolve({ ok: false, error: new AppError('OUT_OF_MOUNT', 'no') }),
    });

    const result = await controller.remove(created, true);

    expect(result.ok).toBe(false);
    expect(settings.get().subscriptions).toHaveLength(1);
  });

  it('re-pulls a single page on demand (FR-3.8)', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];
    await controller.sync(created);
    client.fetched.length = 0;

    const result = await controller.pullPage('ENG/A.md');

    expect(result.ok && result.value.pageId).toBe('1');
    expect(client.fetched).toEqual(['1']);
  });

  it('refuses to pull a note outside every subscription', async () => {
    const result = await controller.pullPage('Personal/notes.md');
    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });

  it('refuses to pull a note with no Confluence identity', async () => {
    await controller.create(DRAFT);
    vault.addForeignNote('ENG/mine.md', 'personal\n');

    const result = await controller.pullPage('ENG/mine.md');
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });

  it('exposes the page URL for the open-in-Confluence command (FR-10.5)', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];
    await controller.sync(created);

    expect(controller.pageUrlFor('ENG/A.md')).toContain('pageId=1');
    expect(controller.pageUrlFor('Personal/x.md')).toBeNull();
  });

  it('tells subscribers when a sync starts and finishes', async () => {
    const created = await controller.create(DRAFT);
    client.pages = [{ id: '1', title: 'A' }];
    let changes = 0;
    const stop = controller.onChange(() => {
      changes += 1;
    });

    await controller.sync(created);
    stop();

    expect(changes).toBeGreaterThan(1);
    expect(controller.status().running).toBeNull();
  });

  it('cancels a running sync', async () => {
    const created = await controller.create(DRAFT);
    client.pages = Array.from({ length: 8 }, (_, index) => ({
      id: String(index + 1),
      title: `P${String(index + 1)}`,
    }));

    controller.onChange(() => {
      if (controller.status().progress?.phase === 'applying') controller.cancel();
    });

    const result = await controller.sync(created);
    expect(result.ok && result.value.cancelled).toBe(true);
  });
});
