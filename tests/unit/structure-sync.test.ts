import { beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncEngine } from '../../src/sync/sync-engine';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import type { SyncCallbacks, SyncReport } from '../../src/sync/sync-types';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * Local moves and renames through a whole sync (spec FR-7.5 to FR-7.8, US-6).
 *
 * Each test does what a user does: sync once so the mirror exists, rearrange files in
 * the vault, then sync again. The assertions are about what left the machine —
 * `client.updates` — because FR-7.8's confirmation is worth nothing if a request is
 * sent before the answer arrives.
 */

const NOW = '2026-08-10T12:00:00Z';
const LIMITS = { attachmentLimitBytes: 25 * 1_048_576, attachmentsReferencedOnly: true };

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'EP',
  rootPageId: null,
  mountPath: 'EP',
  syncComments: true,
};

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let state: SyncStateStore;
let client: FakeConfluence;
let engine: SyncEngine;

const APPLY: SyncCallbacks = { confirmStructure: () => Promise.resolve(true) };

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
    { id: '3', title: 'Data Model', parentId: '2' },
  ];

  await state.load();
  engine = new SyncEngine({
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    suspensions: new SuspensionRegistry(),
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

/** The mirror as a first sync leaves it. */
async function established(): Promise<void> {
  await sync();
  client.updates.length = 0;
}

function pageState(pageId: string) {
  return state.forSubscription('sub').pages[pageId];
}

describe('renaming a note (FR-7.6, US-6)', () => {
  beforeEach(async () => {
    await established();
    await vault.move('EP/Architecture.md', 'EP/Architecture v2.md');
  });

  it('retitles the page and records the new path', async () => {
    const report = await sync(APPLY);

    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]?.title).toBe('Architecture v2');
    expect(pageState('1')?.title).toBe('Architecture v2');
    expect(pageState('1')?.localPath).toBe('EP/Architecture v2.md');
    expect(report.structural).toHaveLength(1);
  });

  it('sends the page’s own body back, so a structural change cannot rewrite it', async () => {
    // A colleague's edit from a minute ago has to survive a rename. Moving a page is
    // not an opinion about its contents.
    client.pages = client.pages.map((page) =>
      page.id === '1' ? { ...page, version: 9, storage: '<p>Their newer words.</p>' } : page,
    );

    await sync(APPLY);

    expect(client.updates[0]?.storage).toBe('<p>Their newer words.</p>');
    expect(client.updates[0]?.version).toBe(10);
  });

  it('sends nothing at all when the user declines (FR-7.8)', async () => {
    const report = await sync({ confirmStructure: () => Promise.resolve(false) });

    expect(client.updates).toEqual([]);
    expect(report.structural).toEqual([]);
    expect(report.structuralDeclined).toHaveLength(1);
    // The index still describes the world as it was, so the next sync asks again.
    expect(pageState('1')?.title).toBe('Architecture');
  });

  it('sends nothing when there is nobody to ask', async () => {
    // A sync that cannot ask must not choose — the same rule conflicts and deletions
    // follow, and the one that matters most for somebody else's documentation.
    const report = await sync();

    expect(client.updates).toEqual([]);
    expect(report.structuralDeclined).toHaveLength(1);
  });

  it('writes the body into the file where it now is, not where the tree says', async () => {
    // Otherwise the pull creates a *second* note for one page: one at the old path
    // with the new body, one at the new path with the old.
    client.pages = client.pages.map((page) =>
      page.id === '1' ? { ...page, version: 4, storage: '<p>Newer.</p>' } : page,
    );

    await sync(APPLY);

    expect(vault.files.has('EP/Architecture.md')).toBe(false);
    expect(vault.files.get('EP/Architecture v2.md')).toContain('Newer.');
  });
});

describe('moving a note (FR-7.5, US-6)', () => {
  beforeEach(async () => {
    await established();
  });

  it('reparents the page under the folder it was dropped into', async () => {
    await vault.move('EP/Architecture.md', 'EP/Design/Architecture.md');

    const report = await sync(APPLY);

    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]?.parentId).toBe('2');
    expect(pageState('1')?.parentId).toBe('2');
    expect(report.structural[0]?.parent?.toTitle).toBe('Design');
  });

  it('reports a move into a folder that is not a page, and sends nothing (FR-7.7)', async () => {
    await vault.move('EP/Architecture.md', 'EP/My Notes/Architecture.md');

    const report = await sync(APPLY);

    expect(client.updates).toEqual([]);
    expect(report.structuralRejected).toHaveLength(1);
    expect(report.structuralRejected[0]?.reason).toContain('not a Confluence page');
  });

  it('moves a page back to the top level of the mount', async () => {
    await vault.move('EP/Design/Data Model.md', 'EP/Data Model.md');

    await sync(APPLY);

    // The mount is the root page's folder (D13), so the top level is under the root.
    expect(client.updates[0]?.parentId).toBe('root');
  });
});

describe('a note that left the mount (FR-7.7)', () => {
  it('is reported as misplaced rather than as an orphan', async () => {
    await established();
    // Dragged out of the mirror entirely. It is not deleted, and offering to delete
    // its page — which is what an orphan offers — would be plainly wrong.
    await vault.move('EP/Architecture.md', 'Personal/Architecture.md');

    const report = await sync(APPLY);

    expect(report.orphans).toEqual([]);
    expect(report.misplaced).toHaveLength(1);
    expect(report.misplaced[0]?.foundAt).toBe('Personal/Architecture.md');
    expect(client.updates).toEqual([]);
    // Left exactly where the user put it.
    expect(vault.files.has('Personal/Architecture.md')).toBe(true);
  });

  it('is an orphan once the file is genuinely gone', async () => {
    await established();
    await vault.trash('EP/Architecture.md');

    const report = await sync(APPLY);

    expect(report.misplaced).toEqual([]);
    expect(report.orphans).toHaveLength(1);
    // D6: a local deletion never reaches Confluence.
    expect(client.deleted).toEqual([]);
  });
});

describe('a folder renamed by hand (FR-7.6)', () => {
  it('renames the folder back to match its note, and follows its children', async () => {
    await established();
    await vault.move('EP/Design', 'EP/Designs');

    await sync(APPLY);

    // The note's name is authoritative, so the folder is corrected rather than the
    // page retitled.
    expect(vault.files.has('EP/Design/Design.md')).toBe(true);
    expect(client.updates).toEqual([]);
    // The child travelled with the folder, so its recorded path has to travel too.
    expect(pageState('3')?.localPath).toBe('EP/Design/Data Model.md');
  });
});
