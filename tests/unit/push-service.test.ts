import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../src/settings/settings-store';
import type { ConnectionProfile, Subscription } from '../../src/settings/settings-types';
import type { ConflictDecision } from '../../src/sync/conflict-executor';
import { FragmentStore } from '../../src/sync/fragment-store';
import { PushService, type PushPrompts } from '../../src/sync/push-service';
import type { PageState } from '../../src/sync/sync-state';
import { SyncStateStore } from '../../src/sync/sync-state';
import { sha256 } from '../../src/util/hash';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * The push service (spec FR-5.6, US-4, US-5).
 *
 * Where `push-executor` is one page, this is *which* pages: the note the user is
 * looking at, or everything in a subscription that has actually changed. US-4 is
 * explicit that an unmodified note must cost no request at all, which on a space
 * the size of EP is the difference between one call and a thousand.
 */

const CONNECTION: ConnectionProfile = {
  id: 'conn',
  displayName: 'Corp',
  baseUrl: 'https://wiki.corp',
  strictMarkup: false,
};

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'ENG',
  rootPageId: null,
  mountPath: 'ENG',
  syncComments: true,
};

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let state: SyncStateStore;
let client: FakeConfluence;
let service: PushService;

function pageState(id: string, path: string, extra: Partial<PageState> = {}): PageState {
  return {
    pageId: id,
    title: `Page ${id}`,
    parentId: null,
    remoteVersion: 1,
    localPath: path,
    isFolderNote: false,
    alias: null,
    attachments: {},
    localHash: 'recorded',
    storageHash: 'storage',
    fidelity: 'certified',
    lastSyncedAt: '2026-08-10T12:00:00Z',
    labels: [],
    ...extra,
  };
}

/** Puts a note on disk, records it, and marks it modified or not as asked. */
async function track(id: string, path: string, body: string, modified: boolean): Promise<void> {
  const content = `---\nconfluence:\n  id: ${id}\n---\n${body}`;
  vault.files.set(path, content);
  vault.identities.set(path, {
    id,
    space: 'ENG',
    version: 1,
    parent: null,
    url: '',
    updated: '',
    updatedBy: '',
    fidelity: 'certified',
  });

  const current = state.forSubscription('sub');
  await state.replace('sub', {
    ...current,
    pages: {
      ...current.pages,
      [id]: pageState(id, path, {
        localHash: modified ? 'something-else' : await sha256(content),
      }),
    },
  });
}

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  await state.load();

  const settings = new SettingsStore(
    {
      loadData: () => Promise.resolve({ connections: [CONNECTION], subscriptions: [SUBSCRIPTION] }),
      saveData: () => Promise.resolve(),
    },
    new Logger('test', () => false),
  );
  await settings.load();

  const fragments = new FragmentStore(stateGateway);
  service = new PushService({
    settings,
    vault,
    fragments,
    state,
    backups: fakeBackups(stateGateway),
    logger: new Logger('test', () => false),
    createClient: () => client,
    now: () => '2026-08-11T09:00:00Z',
  });

  // Every page the tests push starts from a completed pull, so each has a sidecar.
  for (const id of ['1', '2', '3']) await fragments.save(id, 'hash', new Map());
});

describe('pushing one note (FR-5.6)', () => {
  it('pushes the page behind it', async () => {
    client.pages = [{ id: '1', title: 'Page 1', version: 1 }];
    await track('1', 'ENG/One.md', 'Edited.', true);

    const result = await service.pushNote('ENG/One.md');

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.pushed.map((page) => page.pageId)).toEqual(['1']);
    expect(client.updates[0]?.version).toBe(2);
  });

  it('records the new version in the index', async () => {
    client.pages = [{ id: '1', title: 'Page 1', version: 1 }];
    await track('1', 'ENG/One.md', 'Edited.', true);

    await service.pushNote('ENG/One.md');

    expect(state.forSubscription('sub').pages['1']?.remoteVersion).toBe(2);
  });

  it('refuses a note outside every mount', async () => {
    const result = await service.pushNote('Personal/Diary.md');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OUT_OF_MOUNT');
    expect(client.updates).toHaveLength(0);
  });

  it('refuses a note the index has never seen', async () => {
    // Nothing to push *against*: without a recorded version, the plugin cannot
    // tell a first publication from an overwrite of somebody else's page.
    vault.files.set('ENG/Stray.md', '---\nconfluence:\n  id: 9\n---\nBody\n');
    vault.identities.set('ENG/Stray.md', {
      id: '9',
      space: 'ENG',
      version: 1,
      parent: null,
      url: '',
      updated: '',
      updatedBy: '',
      fidelity: 'certified',
    });

    const result = await service.pushNote('ENG/Stray.md');

    expect(result.ok).toBe(false);
    expect(client.updates).toHaveLength(0);
  });
});

describe('pushing every modified note (FR-5.6, US-4)', () => {
  beforeEach(() => {
    client.pages = [
      { id: '1', title: 'Page 1', version: 1 },
      { id: '2', title: 'Page 2', version: 1 },
      { id: '3', title: 'Page 3', version: 1 },
    ];
  });

  it('makes no API call for a note that did not change', async () => {
    await track('1', 'ENG/One.md', 'Edited.', true);
    await track('2', 'ENG/Two.md', 'Untouched.', false);
    await track('3', 'ENG/Three.md', 'Also untouched.', false);

    const result = await service.pushSubscription(SUBSCRIPTION);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.pushed.map((page) => page.pageId)).toEqual(['1']);
    expect(result.value.skipped).toBe(2);
    // The whole assertion: not one request touched the two unchanged pages, not
    // even the version check.
    expect(client.fetched).toEqual(['1']);
    expect(client.updates).toHaveLength(1);
  });

  it('carries on past a page a gate refused', async () => {
    await track('1', 'ENG/One.md', 'Edited.', true);
    await track('2', 'ENG/Two.md', 'Edited too.', true);
    const current = state.forSubscription('sub');
    await state.replace('sub', {
      ...current,
      pages: {
        ...current.pages,
        '1': pageState('1', 'ENG/One.md', { localHash: 'x', fidelity: 'degraded' }),
      },
    });

    const result = await service.pushSubscription(SUBSCRIPTION);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.blocked.map((page) => page.error.code)).toEqual(['FIDELITY_DEGRADED']);
    expect(result.value.pushed.map((page) => page.pageId)).toEqual(['2']);
  });

  it('leaves an orphan alone rather than pushing it (decision D6)', async () => {
    // Recorded in the index, gone from the vault. Nothing to push, and a local
    // deletion must never become a remote action.
    await track('1', 'ENG/One.md', 'Edited.', true);
    vault.files.delete('ENG/One.md');

    const result = await service.pushSubscription(SUBSCRIPTION);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.pushed).toHaveLength(0);
    expect(client.updates).toHaveLength(0);
  });

  it('refuses when the subscription points at a connection that is gone', async () => {
    const result = await service.pushSubscription({ ...SUBSCRIPTION, connectionId: 'missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CREDENTIALS_UNAVAILABLE');
  });
});

describe('the questions a push asks (FR-5.7, FR-6.5)', () => {
  beforeEach(async () => {
    client.pages = [{ id: '1', title: 'Page 1', version: 1 }];
    // `_x_` round-trips to `*x*`: representable, but not byte-identical, which is
    // exactly what verification stops and what force push exists to override.
    await track('1', 'ENG/One.md', 'A _stressed_ word.', true);
  });

  it('does not force a push when nothing is there to ask', async () => {
    const result = await service.pushSubscription(SUBSCRIPTION);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.blocked).toHaveLength(1);
    expect(client.updates).toHaveLength(0);
  });

  it('retries with force only after the user confirmed it', async () => {
    const asked: string[] = [];
    const prompts: PushPrompts = {
      onVerificationFailure: (page) => {
        asked.push(page.title);
        return Promise.resolve(true);
      },
    };

    const result = await service.pushSubscription(SUBSCRIPTION, prompts);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(asked).toEqual(['Page 1']);
    expect(result.value.pushed).toHaveLength(1);
  });

  it('leaves the push blocked when the user declined', async () => {
    const result = await service.pushSubscription(SUBSCRIPTION, {
      onVerificationFailure: () => Promise.resolve(false),
    });

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.blocked).toHaveLength(1);
    expect(client.updates).toHaveLength(0);
  });

  it('presents every conflict at once rather than one modal per page (FR-6.5)', async () => {
    client.pages = [
      { id: '1', title: 'Page 1', version: 4 },
      { id: '2', title: 'Page 2', version: 4 },
    ];
    await track('1', 'ENG/One.md', 'Mine.', true);
    await track('2', 'ENG/Two.md', 'Mine too.', true);

    let batches = 0;
    const result = await service.pushSubscription(SUBSCRIPTION, {
      onConflicts: (conflicts): Promise<readonly ConflictDecision[]> => {
        batches += 1;
        return Promise.resolve(conflicts.map((conflict) => ({ conflict, choice: 'skip' })));
      },
    });

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(batches).toBe(1);
    expect(result.value.conflicts).toHaveLength(2);
  });

  it('leaves conflicts untouched when there is no way to ask about them', async () => {
    client.pages = [{ id: '1', title: 'Page 1', version: 9 }];
    await track('1', 'ENG/One.md', 'Mine.', true);

    const result = await service.pushSubscription(SUBSCRIPTION);

    if (!result.ok) throw new Error(result.error.userMessage);
    expect(result.value.conflicts).toHaveLength(0);
    expect(result.value.pushed).toHaveLength(0);
    expect(client.updates).toHaveLength(0);
  });
});
