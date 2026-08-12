import { beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/settings/settings-types';
import {
  applyDemotions,
  describeDemotion,
  planDemotions,
  type TidyDeps,
} from '../../src/sync/demotion';
import { SyncStateStore, type PageState } from '../../src/sync/sync-state';
import { Logger } from '../../src/util/logger';
import { FakeStateGateway, FakeVaultGateway } from '../fakes/sync';

/**
 * Demotion — the `Tidy folder notes` command (spec §6.5.4).
 *
 * The rule under test is that demotion is never automatic and never guessed. A
 * folder note is moved out only when the index says the page has no children *and*
 * the vault says the folder holds nothing else — and the page that collapses into
 * the mount (D13) is never touched at all, because that folder is the user's.
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
let state: SyncStateStore;
let deps: TidyDeps;

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

/** Seeds the index and the vault with the same set of pages. */
async function seed(pages: readonly PageState[]): Promise<void> {
  await state.replace('sub', {
    lastSyncedAt: null,
    pages: Object.fromEntries(pages.map((page) => [page.pageId, page])),
  });
  for (const page of pages) {
    vault.files.set(page.localPath, `---\nconfluence:\n  id: ${page.pageId}\n---\nbody`);
  }
}

beforeEach(async () => {
  vault = new FakeVaultGateway();
  state = new SyncStateStore(new FakeStateGateway());
  await state.load();

  deps = {
    vault,
    state,
    logger: new Logger('test', () => false),
    record: async (subscriptionId, page) => {
      const current = state.forSubscription(subscriptionId);
      await state.replace(subscriptionId, {
        ...current,
        pages: { ...current.pages, [page.pageId]: page },
      });
    },
  };
});

describe('planDemotions', () => {
  it('plans a folder note whose page has no children', async () => {
    await seed([
      tracked({ pageId: 'root', title: 'Home', parentId: null, localPath: 'EP/EP.md' }),
      tracked({ pageId: '2' }),
    ]);

    const plan = planDemotions(deps, SUBSCRIPTION);

    expect(plan.rejected).toEqual([]);
    expect(plan.ops).toEqual([
      {
        pageId: '2',
        title: 'Design',
        from: 'EP/Design/Design.md',
        to: 'EP/Design.md',
        folder: 'EP/Design',
      },
    ]);
  });

  it('leaves a folder note whose page still has children', async () => {
    await seed([
      tracked({ pageId: '2' }),
      tracked({
        pageId: '3',
        title: 'Schema',
        parentId: '2',
        localPath: 'EP/Design/Schema.md',
        isFolderNote: false,
      }),
    ]);

    expect(planDemotions(deps, SUBSCRIPTION)).toEqual({ ops: [], rejected: [] });
  });

  it('never demotes the page that collapses into the mount', async () => {
    // D13: the mount folder's name is the user's, and the root note lives in it.
    await seed([tracked({ pageId: 'root', title: 'Home', parentId: null, localPath: 'EP/EP.md' })]);

    expect(planDemotions(deps, SUBSCRIPTION)).toEqual({ ops: [], rejected: [] });
  });

  it('never demotes a folder note sitting at the mount root even without a root page', async () => {
    await seed([tracked({ pageId: '9', title: 'EP', parentId: null, localPath: 'EP/EP.md' })]);

    expect(planDemotions(deps, { ...SUBSCRIPTION, rootPageId: null })).toEqual({
      ops: [],
      rejected: [],
    });
  });

  it('refuses a folder that still holds something else, and says what', async () => {
    await seed([tracked({ pageId: '2' })]);
    // A file the plugin does not manage: demoting would strand it in a folder no
    // page owns, and the next sync would refuse every note in it.
    vault.binaries.set('EP/Design/diagram.png', new Uint8Array([1]));

    const plan = planDemotions(deps, SUBSCRIPTION);

    expect(plan.ops).toEqual([]);
    expect(plan.rejected[0]?.path).toBe('EP/Design/Design.md');
    expect(plan.rejected[0]?.reason).toContain('1 other item(s)');
  });

  it('refuses when a note already occupies the path it would move to', async () => {
    await seed([tracked({ pageId: '2' })]);
    vault.files.set('EP/Design.md', 'someone else');

    const plan = planDemotions(deps, SUBSCRIPTION);

    expect(plan.ops).toEqual([]);
    expect(plan.rejected[0]?.reason).toContain('already exists');
  });

  it('takes the target name from the note, not the folder', async () => {
    // The file name is authoritative (§6.5.4). A folder still carrying the old
    // title must not decide where the note lands.
    await seed([tracked({ pageId: '2', localPath: 'EP/Old name/New name.md' })]);

    expect(planDemotions(deps, SUBSCRIPTION).ops[0]?.to).toBe('EP/New name.md');
  });
});

describe('applyDemotions', () => {
  it('moves the note, removes the emptied folder and records the new path', async () => {
    await seed([tracked({ pageId: '2' })]);
    vault.folders.add('EP/Design');

    const outcome = await applyDemotions(deps, SUBSCRIPTION, planDemotions(deps, SUBSCRIPTION).ops);

    expect(outcome.failures).toEqual([]);
    expect(vault.moves).toEqual([{ from: 'EP/Design/Design.md', to: 'EP/Design.md' }]);
    expect(vault.folders.has('EP/Design')).toBe(false);

    const page = state.forSubscription('sub').pages['2'];
    expect(page?.localPath).toBe('EP/Design.md');
    expect(page?.isFolderNote).toBe(false);
  });

  it('reports a failed move and carries on with the rest', async () => {
    await seed([
      tracked({ pageId: '2' }),
      tracked({ pageId: '3', title: 'Ops', localPath: 'EP/Ops/Ops.md' }),
    ]);
    const ops = planDemotions(deps, SUBSCRIPTION).ops;
    // The first note is gone from under us, as an external sync tool could leave it.
    vault.files.delete('EP/Design/Design.md');

    const outcome = await applyDemotions(deps, SUBSCRIPTION, ops);

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.path).toBe('EP/Design/Design.md');
    expect(outcome.demoted.map((op) => op.pageId)).toEqual(['3']);
    expect(state.forSubscription('sub').pages['2']?.isFolderNote).toBe(true);
  });

  it('leaves the index alone for a page that vanished from it mid-tidy', async () => {
    await seed([tracked({ pageId: '2' })]);
    const ops = planDemotions(deps, SUBSCRIPTION).ops;
    await state.replace('sub', { lastSyncedAt: null, pages: {} });

    const outcome = await applyDemotions(deps, SUBSCRIPTION, ops);

    expect(outcome.demoted).toHaveLength(1);
    expect(state.forSubscription('sub').pages).toEqual({});
  });
});

describe('describeDemotion', () => {
  it('names the folder the note leaves', async () => {
    await seed([tracked({ pageId: '2' })]);
    const op = planDemotions(deps, SUBSCRIPTION).ops[0];

    expect(op === undefined ? '' : describeDemotion(op)).toBe(
      'move out of "Design/" — the page has no children',
    );
  });
});
