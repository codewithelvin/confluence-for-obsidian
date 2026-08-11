import { beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/settings/settings-types';
import type { ConflictChoice, ConflictDecision } from '../../src/sync/conflict-executor';
import { FragmentStore } from '../../src/sync/fragment-store';
import type { PageConflict } from '../../src/sync/push-executor';
import { SuspensionRegistry } from '../../src/sync/suspension';
import { SyncEngine } from '../../src/sync/sync-engine';
import { SyncStateStore } from '../../src/sync/sync-state';
import { nextSubscriptionState } from '../../src/sync/sync-persist';
import type { SyncCallbacks, SyncReport } from '../../src/sync/sync-types';
import { Logger } from '../../src/util/logger';
import { sha256 } from '../../src/util/hash';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * Conflicts as a *sync* meets them (spec §6.6.2 step 5, US-5).
 *
 * US-5's first criterion is about syncing, not pushing: "given local edits and a
 * newer remote version, when I sync, then a conflict modal appears". So the engine
 * has to raise the question itself — and §6.6.2 is specific that it does so
 * **before any write**, which is what the ordering tests below pin down.
 */

const NOW = '2026-08-11T09:00:00Z';
const LIMITS = { attachmentLimitBytes: 25 * 1_048_576, attachmentsReferencedOnly: true };

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
let engine: SyncEngine;

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  await state.load();

  engine = new SyncEngine({
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    suspensions: new SuspensionRegistry(),
    backups: fakeBackups(stateGateway, () => NOW),
    logger: new Logger('test', () => false),
    now: () => NOW,
  });
});

async function sync(callbacks: SyncCallbacks = {}): Promise<SyncReport> {
  const result = await engine.sync(
    {
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    },
    callbacks,
  );
  if (!result.ok) throw new Error(`sync failed: ${result.error.userMessage}`);
  return result.value;
}

/**
 * Leaves the vault and the index in the one state that produces a conflict: the
 * note edited here, the page edited there.
 */
async function conflicted(): Promise<void> {
  client.pages = [{ id: '1', title: 'A', version: 5, storage: '<p>Remote text.</p>' }];
  await sync();

  const content = '---\nconfluence:\n  id: 1\n---\nMy own edit.\n';
  vault.files.set('ENG/A.md', content);
  client.pages = [{ id: '1', title: 'A', version: 6, storage: '<p>Their newer text.</p>' }];
}

function answering(choice: ConflictChoice): SyncCallbacks {
  return {
    resolveConflicts: (conflicts): Promise<readonly ConflictDecision[]> =>
      Promise.resolve(conflicts.map((conflict) => ({ conflict, choice }))),
  };
}

describe('a sync raises the conflict itself (US-5)', () => {
  it('classifies the page as conflicted and pulls neither side', async () => {
    await conflicted();

    const report = await sync();

    expect(report.conflicts.map((page) => page.pageId)).toEqual(['1']);
    expect(report.pulled).toBe(0);
    expect(vault.files.get('ENG/A.md')).toContain('My own edit.');
  });

  it('asks with the remote author, timestamp and a readable diff (FR-6.3)', async () => {
    await conflicted();
    const asked: PageConflict[] = [];

    await sync({
      resolveConflicts: (conflicts) => {
        asked.push(...conflicts);
        return Promise.resolve([]);
      },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.remoteVersion).toBe(6);
    expect(asked[0]?.remoteUpdatedBy).toBe('j.smith');
    expect(asked[0]?.localBody).toContain('My own edit.');
    expect(asked[0]?.remoteBody).toContain('Their newer text.');
  });

  it('does not ask at all when there is nothing to ask about', async () => {
    client.pages = [{ id: '1', title: 'A', version: 1 }];
    let asked = 0;

    await sync({
      resolveConflicts: () => {
        asked += 1;
        return Promise.resolve([]);
      },
    });

    expect(asked).toBe(0);
  });

  it('leaves both copies alone when the caller cannot ask', async () => {
    await conflicted();

    const report = await sync();

    expect(report.conflictsResolved).toEqual([]);
    expect(vault.files.get('ENG/A.md')).toContain('My own edit.');
    expect(client.updates).toHaveLength(0);
  });
});

describe('applying the answer inside a sync', () => {
  it('Keep Local publishes over the version the user was shown (FR-6.4)', async () => {
    await conflicted();

    const report = await sync(answering('keep-local'));

    expect(client.updates[0]?.version).toBe(7);
    expect(report.conflictsResolved[0]?.choice).toBe('keep-local');
    expect(state.forSubscription('sub').pages['1']?.remoteVersion).toBe(7);
  });

  it('Keep Remote backs the note up and then replaces it (FR-6.6, US-5)', async () => {
    await conflicted();

    await sync(answering('keep-remote'));

    const backups = [...stateGateway.files.keys()].filter((name) => name.startsWith('backups/'));
    expect(backups).toHaveLength(1);
    expect(stateGateway.files.get(backups[0] ?? '')).toContain('My own edit.');
    expect(vault.files.get('ENG/A.md')).toContain('Their newer text.');
  });

  it('Save Both writes "<Title> (remote vN).md" and excludes it from sync (US-5)', async () => {
    await conflicted();

    const report = await sync(answering('save-both'));

    expect(report.conflictsResolved[0]?.copyPath).toBe('ENG/A (remote v6).md');
    expect(vault.files.get('ENG/A (remote v6).md')).toContain('Their newer text.');

    // The next sync must not report the copy as an untracked candidate.
    const next = await sync();
    expect(next.untracked).toEqual([]);
  });

  it('settles the conflict so it is not raised again every sync', async () => {
    await conflicted();
    await sync(answering('save-both'));

    // The note is still the user's and still modified, so it is now an ordinary
    // local edit waiting to be pushed — not a conflict.
    const next = await sync();

    expect(next.conflicts).toEqual([]);
    expect(next.localEdits.map((page) => page.pageId)).toEqual(['1']);
  });

  it('records a resolution that failed instead of reporting success', async () => {
    await conflicted();
    stateGateway.failWrites = true;

    const report = await sync(answering('keep-remote'));

    expect(report.conflictsResolved[0]?.error?.code).toBe('VAULT_WRITE_FAILED');
    expect(vault.files.get('ENG/A.md')).toContain('My own edit.');
  });

  it('ignores a decision for a page it never raised', async () => {
    await conflicted();

    const report = await sync({
      resolveConflicts: (conflicts) =>
        Promise.resolve([
          ...conflicts.map((conflict) => ({ conflict, choice: 'skip' as const })),
          {
            conflict: { ...(conflicts[0] as PageConflict), pageId: '999' },
            choice: 'keep-remote' as const,
          },
        ]),
    });

    expect(report.conflictsResolved).toHaveLength(1);
    expect(client.updates).toHaveLength(0);
  });
});

describe('the order §6.6.2 requires', () => {
  it('asks before it writes anything', async () => {
    // Step 5 before step 6. Asking "do you want to keep your local edits?" after
    // the sync has already rewritten notes is asking about a state that is gone.
    client.pages = [
      { id: '1', title: 'A', version: 5, storage: '<p>Remote text.</p>' },
      { id: '2', title: 'B', version: 1 },
    ];
    await sync();

    vault.files.set('ENG/A.md', '---\nconfluence:\n  id: 1\n---\nMy own edit.\n');
    client.pages = [
      { id: '1', title: 'A', version: 6, storage: '<p>Newer.</p>' },
      { id: '2', title: 'B', version: 2 },
    ];
    // The setup sync above wrote both notes; only the second sync's writes matter.
    vault.writes.length = 0;

    let writesWhenAsked = -1;
    await sync({
      resolveConflicts: (conflicts) => {
        writesWhenAsked = vault.writes.length;
        return Promise.resolve(
          conflicts.map((conflict) => ({ conflict, choice: 'skip' as const })),
        );
      },
    });

    // Page 2 needed pulling this sync. Nothing had been written when the question
    // was put.
    expect(writesWhenAsked).toBe(0);
    expect(vault.writes).toContain('ENG/B.md');
  });
});

describe('what the index ends up holding (§6.6.2 step 7)', () => {
  const record = {
    pageId: '1',
    title: 'A',
    parentId: null,
    remoteVersion: 1,
    localPath: 'ENG/A.md',
    isFolderNote: false,
    alias: null,
    attachments: {},
    localHash: 'h',
    storageHash: 's',
    fidelity: 'certified' as const,
    lastSyncedAt: '2026-08-01T00:00:00Z',
    labels: [],
  };

  it('patches a relocated page rather than replacing its record', () => {
    const next = nextSubscriptionState(
      { lastSyncedAt: null, pages: { '1': record } },
      {
        relocated: [
          { pageId: '1', title: 'Renamed', moves: [], to: 'ENG/Renamed.md', isFolderNote: true },
        ],
        deleted: [],
        states: [],
        forget: [],
      },
      NOW,
    );

    expect(next.pages['1']?.localPath).toBe('ENG/Renamed.md');
    expect(next.pages['1']?.title).toBe('Renamed');
    expect(next.pages['1']?.isFolderNote).toBe(true);
    // Untouched: a page that only moved was never fetched.
    expect(next.pages['1']?.localHash).toBe('h');
  });

  it('lets a deletion win over a relocation planned in the same sync', () => {
    const next = nextSubscriptionState(
      { lastSyncedAt: null, pages: { '1': record } },
      {
        relocated: [
          { pageId: '1', title: 'A', moves: [], to: 'ENG/Moved.md', isFolderNote: false },
        ],
        deleted: [{ pageId: '1', title: 'A', path: 'ENG/A.md' }],
        states: [],
        forget: [],
      },
      NOW,
    );

    expect(next.pages['1']).toBeUndefined();
  });

  it('drops an entry for a page gone on both sides', () => {
    const next = nextSubscriptionState(
      { lastSyncedAt: null, pages: { '1': record } },
      { relocated: [], deleted: [], states: [], forget: ['1'] },
      NOW,
    );

    expect(next.pages).toEqual({});
    expect(next.lastSyncedAt).toBe(NOW);
  });

  it('ignores a relocation for a page it has no record of', () => {
    const next = nextSubscriptionState(
      { lastSyncedAt: null, pages: {} },
      {
        relocated: [{ pageId: '7', title: 'X', moves: [], to: 'ENG/X.md', isFolderNote: false }],
        deleted: [],
        states: [],
        forget: [],
      },
      NOW,
    );

    expect(next.pages).toEqual({});
  });

  it('takes a pulled record over a conflict resolution for the same page', async () => {
    // Both can be produced in one sync and they cannot both be right; the pull is
    // the later write.
    const next = nextSubscriptionState(
      { lastSyncedAt: null, pages: {} },
      {
        relocated: [],
        deleted: [],
        states: [
          { ...record, storageHash: 'from-resolution' },
          { ...record, storageHash: 'from-pull', localHash: await sha256('pulled') },
        ],
        forget: [],
      },
      NOW,
    );

    expect(next.pages['1']?.storageHash).toBe('from-pull');
  });
});
