import { describe, expect, it } from 'vitest';
import type { ConfluencePageRef } from '../../src/api/api-types';
import { buildPullPlan, type PullPlan } from '../../src/sync/pull-planner';
import type { PageState, SubscriptionState } from '../../src/sync/sync-state';
import { buildPathMap } from '../../src/vault/path-mapper';
import type { ScannedNote } from '../../src/vault/vault-gateway';
import type { ConfluenceIdentity } from '../../src/vault/frontmatter';

function ref(id: string, title: string, extra: Partial<ConfluencePageRef> = {}): ConfluencePageRef {
  return {
    id,
    title,
    spaceKey: 'ENG',
    version: 1,
    parentId: null,
    updatedAt: '2026-08-09T14:03:11Z',
    updatedBy: 'j.smith',
    ...extra,
  };
}

function identity(id: string): ConfluenceIdentity {
  return {
    id,
    space: 'ENG',
    version: 1,
    parent: null,
    url: '',
    updated: '',
    updatedBy: '',
    fidelity: 'certified',
  };
}

function note(id: string, path: string, hash: string): ScannedNote {
  return { path, hash, identity: identity(id) };
}

function tracked(id: string, path: string, extra: Partial<PageState> = {}): PageState {
  return {
    pageId: id,
    title: 'Title',
    parentId: null,
    remoteVersion: 1,
    localPath: path,
    isFolderNote: false,
    alias: null,
    localHash: 'hash',
    storageHash: 'storage',
    fidelity: 'certified',
    lastSyncedAt: '2026-08-01T00:00:00Z',
    ...extra,
  };
}

function stateOf(...pages: PageState[]): SubscriptionState {
  return {
    lastSyncedAt: '2026-08-01T00:00:00Z',
    pages: Object.fromEntries(pages.map((page) => [page.pageId, page])),
  };
}

function plan(
  remote: readonly ConfluencePageRef[],
  local: readonly ScannedNote[],
  state: SubscriptionState = stateOf(),
): PullPlan {
  const paths = buildPathMap(remote, {
    mountPath: 'ENG',
    rootPageId: null,
    vaultPathLength: 20,
    keepAsFolderNote: new Set(
      Object.values(state.pages)
        .filter((page) => page.isFolderNote)
        .map((page) => page.pageId),
    ),
  });
  return buildPullPlan({ remote, local, state, paths });
}

describe('first sync', () => {
  it('pulls every page as new', () => {
    const result = plan([ref('1', 'A'), ref('2', 'B', { parentId: '1' })], []);

    expect(result.pull.map((item) => item.path)).toEqual(['ENG/A/A.md', 'ENG/A/B.md']);
    expect(result.pull.every((item) => item.isNew)).toBe(true);
    expect(result.pull[0]?.isFolderNote).toBe(true);
  });
});

describe('change detection', () => {
  it('leaves an untouched page alone', () => {
    const result = plan(
      [ref('1', 'A')],
      [note('1', 'ENG/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.pull).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('pulls a page whose remote version moved on', () => {
    const result = plan(
      [ref('1', 'A', { version: 2 })],
      [note('1', 'ENG/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.pull).toHaveLength(1);
    expect(result.pull[0]?.isNew).toBe(false);
  });

  it('reports a locally edited page rather than overwriting it', () => {
    // Read-only sync must never destroy an edit; push arrives with M5.
    const result = plan(
      [ref('1', 'A')],
      [note('1', 'ENG/A.md', 'edited')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.pull).toHaveLength(0);
    expect(result.localEdits.map((page) => page.pageId)).toEqual(['1']);
  });

  it('reports a conflict when both sides changed, and pulls neither', () => {
    const result = plan(
      [ref('1', 'A', { version: 2 })],
      [note('1', 'ENG/A.md', 'edited')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.pull).toHaveLength(0);
    expect(result.conflicts.map((page) => page.pageId)).toEqual(['1']);
  });

  it('recognises a note the user moved by its identity, not its path', () => {
    // Otherwise the same file is reported as an orphan and as an untracked
    // candidate at the same time.
    const result = plan(
      [ref('1', 'A')],
      [note('1', 'ENG/Moved by hand.md', 'hash')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.orphans).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
  });
});

describe('pages that disappeared', () => {
  it('reports a tracked page whose note was deleted as an orphan (decision D6)', () => {
    const result = plan([ref('1', 'A')], [], stateOf(tracked('1', 'ENG/A.md')));

    expect(result.orphans.map((page) => page.pageId)).toEqual(['1']);
    expect(result.deleteLocal).toHaveLength(0);
  });

  it('proposes deleting a note whose page is gone from Confluence', () => {
    const result = plan([], [note('1', 'ENG/A.md', 'hash')], stateOf(tracked('1', 'ENG/A.md')));

    expect(result.deleteLocal.map((page) => page.path)).toEqual(['ENG/A.md']);
  });

  it('forgets a page that is gone on both sides without asking', () => {
    const result = plan([], [], stateOf(tracked('1', 'ENG/A.md')));

    expect(result.deleteLocal).toHaveLength(0);
    expect(result.forget).toEqual(['1']);
  });
});

describe('untracked files', () => {
  it('reports Markdown in the mount that the plugin does not own', () => {
    const result = plan(
      [ref('1', 'A')],
      [note('1', 'ENG/A.md', 'hash'), { path: 'ENG/My notes.md', hash: 'x', identity: null }],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.untracked).toEqual(['ENG/My notes.md']);
  });
});

describe('remote moves and renames', () => {
  it('relocates a renamed page (FR-3.7)', () => {
    const result = plan(
      [ref('1', 'Renamed', { version: 2 })],
      [note('1', 'ENG/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.relocate[0]?.moves).toEqual([{ from: 'ENG/A.md', to: 'ENG/Renamed.md' }]);
    expect(result.pull[0]?.path).toBe('ENG/Renamed.md');
  });

  it('relocates a page moved under a different parent (FR-3.6)', () => {
    const result = plan(
      [ref('1', 'A'), ref('2', 'B'), ref('3', 'C', { parentId: '2', version: 2 })],
      [note('3', 'ENG/A/C.md', 'hash')],
      stateOf(tracked('3', 'ENG/A/C.md', { parentId: '1' })),
    );

    expect(result.relocate[0]?.to).toBe('ENG/B/C.md');
  });

  it('promotes a leaf that gained its first child (decision D9)', () => {
    const result = plan(
      [ref('1', 'A'), ref('2', 'B', { parentId: '1' })],
      [note('1', 'ENG/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A.md')),
    );

    expect(result.relocate[0]?.moves).toEqual([{ from: 'ENG/A.md', to: 'ENG/A/A.md' }]);
  });

  it('moves a folder note by its folder so its children travel with it', () => {
    const result = plan(
      [ref('1', 'Renamed', { version: 2 }), ref('2', 'B', { parentId: '1' })],
      [note('1', 'ENG/A/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A/A.md', { isFolderNote: true })),
    );

    expect(result.relocate[0]?.moves).toEqual([
      { from: 'ENG/A', to: 'ENG/Renamed' },
      { from: 'ENG/Renamed/A.md', to: 'ENG/Renamed/Renamed.md' },
    ]);
  });

  it('never demotes a folder note automatically (spec §6.5.4)', () => {
    // The page lost its last child. Demoting here would move the page — and
    // every wikilink to it — every time a child is added and removed.
    const result = plan(
      [ref('1', 'A')],
      [note('1', 'ENG/A/A.md', 'hash')],
      stateOf(tracked('1', 'ENG/A/A.md', { isFolderNote: true })),
    );

    expect(result.relocate).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it('moves parents before their children', () => {
    const result = plan(
      [ref('1', 'Renamed', { version: 2 }), ref('2', 'B', { parentId: '1' })],
      [note('1', 'ENG/A/A.md', 'hash'), note('2', 'ENG/A/B.md', 'hash')],
      stateOf(tracked('1', 'ENG/A/A.md', { isFolderNote: true }), tracked('2', 'ENG/A/B.md')),
    );

    expect(result.relocate[0]?.pageId).toBe('1');
  });
});

describe('path budget', () => {
  it('reports a page whose name had to be shortened', () => {
    const result = plan([ref('8061060', 'x'.repeat(400))], []);
    expect(result.truncated.map((page) => page.pageId)).toEqual(['8061060']);
  });

  it('passes on pages that could not be placed at all', () => {
    const paths = buildPathMap([ref('1', 'A')], {
      mountPath: 'ENG',
      rootPageId: null,
      vaultPathLength: 300,
    });
    const result = buildPullPlan({ remote: [ref('1', 'A')], local: [], state: stateOf(), paths });

    expect(result.pull).toHaveLength(0);
    expect(result.unmappable).toHaveLength(1);
  });
});
