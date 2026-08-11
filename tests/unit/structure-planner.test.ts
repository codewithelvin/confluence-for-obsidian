import { describe, expect, it } from 'vitest';
import type { ConfluencePageRef } from '../../src/api/api-types';
import type { PullItem } from '../../src/sync/pull-planner';
import { retargetPulls } from '../../src/sync/pull-targets';
import {
  buildStructurePlan,
  describeStructureOp,
  type StructureInput,
} from '../../src/sync/structure-planner';
import type { PageState, SubscriptionState } from '../../src/sync/sync-state';
import type { ScannedNote } from '../../src/vault/vault-gateway';

/**
 * Reading the user's structural intent (spec FR-7.5 to FR-7.9, US-6).
 *
 * Every test here turns on one question: **who moved it?** The same divergence
 * between a note's location and the remote tree means "move the file" when Confluence
 * moved the page and "move the page" when the user moved the file, and the index is
 * the only thing that can tell them apart. Getting it backwards either drags the
 * user's file back or reorganises a corporate wiki nobody asked to reorganise.
 */

const MOUNT = 'EP';

function ref(id: string, title: string, parentId: string | null = 'root'): ConfluencePageRef {
  return {
    id,
    title,
    spaceKey: 'EP',
    version: 1,
    parentId,
    updatedAt: '2026-08-09T14:03:11Z',
    updatedBy: 'j.smith',
  };
}

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

function note(path: string, pageId: string, extra: Partial<ScannedNote> = {}): ScannedNote {
  return {
    path,
    hash: 'hash',
    identity: {
      id: pageId,
      space: 'EP',
      version: 1,
      parent: null,
      url: '',
      updated: '',
      updatedBy: '',
      fidelity: 'certified',
    },
    isConflictCopy: false,
    ...extra,
  };
}

function state(...pages: readonly PageState[]): SubscriptionState {
  return {
    lastSyncedAt: '2026-08-10T12:00:00Z',
    pages: Object.fromEntries(pages.map((page) => [page.pageId, page])),
  };
}

function plan(input: Partial<StructureInput> & Pick<StructureInput, 'remote' | 'local' | 'state'>) {
  return buildStructurePlan({ mountPath: MOUNT, rootPageId: 'root', ...input });
}

/** The mirror the other tests start from: a root page and one child. */
const ROOT = tracked({
  pageId: 'root',
  title: 'E-Portal home',
  parentId: null,
  localPath: 'EP/EP.md',
  isFolderNote: true,
  alias: 'E-Portal home',
});

describe('a rename in Obsidian (FR-7.6)', () => {
  it('becomes a title change in Confluence', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/Architecture v2.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.title).toEqual({ from: 'Architecture', to: 'Architecture v2' });
    expect(result.ops[0]?.parent).toBeNull();
    expect(result.rejected).toEqual([]);
  });

  it('leaves a page nobody renamed alone', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/Architecture.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
  });

  it('is not read from a rename that happened in Confluence', () => {
    // The remote title moved and the file has not: that is FR-3.7's job, and doing
    // anything here would send the old title straight back.
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Renamed remotely')],
      local: [note('EP/EP.md', 'root'), note('EP/Architecture.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('refuses when both sides renamed it, and stops the relocate too', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Theirs')],
      local: [note('EP/EP.md', 'root'), note('EP/Mine.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('renamed in Confluence');
    // Applying the remote half of a change the user was just told was refused would
    // move their file anyway.
    expect(result.suppressRelocate.has('1')).toBe(true);
  });

  it('never renames the page behind the mount folder (D13)', () => {
    // The mount folder's name is the user's, so its note's name is not the title.
    const result = plan({
      remote: [ref('root', 'E-Portal home', null)],
      local: [note('EP/EP.md', 'root')],
      state: state(ROOT),
    });

    expect(result.ops).toEqual([]);
  });
});

describe('a move in Obsidian (FR-7.5)', () => {
  const parent = tracked({
    pageId: '2',
    title: 'Design',
    localPath: 'EP/Design/Design.md',
    isFolderNote: true,
  });

  it('becomes a parent change in Confluence', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture'), ref('2', 'Design')],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Design/Design.md', '2'),
        note('EP/Design/Architecture.md', '1'),
      ],
      state: state(ROOT, tracked({ pageId: '1' }), parent),
    });

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.parent).toEqual({ from: 'root', to: '2', toTitle: 'Design' });
  });

  it('reads a note directly in the mount as a child of the root page (D13)', () => {
    const result = plan({
      remote: [
        ref('root', 'E-Portal home', null),
        ref('1', 'Architecture', '2'),
        ref('2', 'Design'),
      ],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Design/Design.md', '2'),
        note('EP/Architecture.md', '1'),
      ],
      state: state(ROOT, tracked({ pageId: '1', parentId: '2' }), parent),
    });

    expect(result.ops[0]?.parent).toEqual({ from: '2', to: 'root', toTitle: 'E-Portal home' });
  });

  it('refuses a folder that is not a page, rather than guessing an ancestor', () => {
    // Guessing would put the page somewhere the folder structure does not show, and
    // the next sync would move the file back out of the folder the user made.
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/My Notes/Architecture.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('not a Confluence page');
    // Not a both-sides conflict, so a remote-driven relocate may still run.
    expect(result.suppressRelocate.has('1')).toBe(false);
  });

  it('refuses when both sides moved it', () => {
    const result = plan({
      remote: [
        ref('root', 'E-Portal home', null),
        ref('1', 'Architecture', '2'),
        ref('2', 'Design'),
      ],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Design/Design.md', '2'),
        note('EP/Design/Architecture.md', '1'),
      ],
      state: state(ROOT, tracked({ pageId: '1', parentId: 'root' }), parent),
    });

    // Remote says its parent is now 2 and the user also dropped it into Design.
    expect(result.rejected[0]?.reason).toContain('moved in Confluence');
    expect(result.suppressRelocate.has('1')).toBe(true);
  });

  it('refuses a move that would put a page inside itself (FR-7.9)', () => {
    // Dragging a parent into its own child, rejected before any request.
    const outer = tracked({
      pageId: '1',
      title: 'Architecture',
      localPath: 'EP/Architecture/Architecture.md',
      isFolderNote: true,
    });
    const inner = tracked({
      pageId: '2',
      title: 'Design',
      parentId: '1',
      localPath: 'EP/Architecture/Design/Design.md',
      isFolderNote: true,
    });

    const result = plan({
      remote: [
        ref('root', 'E-Portal home', null),
        ref('1', 'Architecture'),
        ref('2', 'Design', '1'),
      ],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Architecture/Design/Design.md', '2'),
        note('EP/Architecture/Design/Architecture/Architecture.md', '1'),
      ],
      state: state(ROOT, outer, inner),
    });

    expect(result.ops).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('inside itself');
  });
});

describe('a folder that no longer matches its note (FR-7.6)', () => {
  it('renames the folder, because the file name is authoritative', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/Arch/Architecture.md', '1')],
      state: state(
        ROOT,
        tracked({ pageId: '1', localPath: 'EP/Architecture/Architecture.md', isFolderNote: true }),
      ),
    });

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.folderRename).toEqual({ from: 'EP/Arch', to: 'EP/Architecture' });
    // The note was not renamed, so the page keeps its title.
    expect(result.ops[0]?.title).toBeNull();
  });

  it('renames the folder and the page together when the note was renamed', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/Architecture/Arch.md', '1')],
      state: state(
        ROOT,
        tracked({ pageId: '1', localPath: 'EP/Architecture/Architecture.md', isFolderNote: true }),
      ),
    });

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.title).toEqual({ from: 'Architecture', to: 'Arch' });
    expect(result.ops[0]?.folderRename).toEqual({ from: 'EP/Architecture', to: 'EP/Arch' });
  });

  it('leaves the mount folder alone (D13)', () => {
    // The mount is called EP and its note is EP.md; renaming either is the user's
    // business, not FR-7.6's.
    const result = plan({
      remote: [ref('root', 'E-Portal home', null)],
      local: [note('EP/EP.md', 'root')],
      state: state(ROOT),
    });

    expect(result.ops).toEqual([]);
  });
});

describe('what the planner ignores', () => {
  it('ignores a "Save Both" snapshot', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Architecture.md', '1'),
        note('EP/Architecture (remote v7).md', '1', { isConflictCopy: true }),
      ],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
  });

  it('ignores a note whose page is no longer in the space', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null)],
      local: [note('EP/EP.md', 'root'), note('EP/Gone renamed.md', '1')],
      state: state(ROOT, tracked({ pageId: '1' })),
    });

    expect(result.ops).toEqual([]);
  });

  it('ignores a note the index has never seen', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture')],
      local: [note('EP/EP.md', 'root'), note('EP/Architecture.md', '1')],
      state: state(ROOT),
    });

    expect(result.ops).toEqual([]);
  });
});

describe('describeStructureOp (FR-7.8)', () => {
  it('reads as a sentence the user can check', () => {
    const result = plan({
      remote: [ref('root', 'E-Portal home', null), ref('1', 'Architecture'), ref('2', 'Design')],
      local: [
        note('EP/EP.md', 'root'),
        note('EP/Design/Design.md', '2'),
        note('EP/Design/Arch.md', '1'),
      ],
      state: state(
        ROOT,
        tracked({ pageId: '1' }),
        tracked({
          pageId: '2',
          title: 'Design',
          localPath: 'EP/Design/Design.md',
          isFolderNote: true,
        }),
      ),
    });

    const op = result.ops[0];
    if (op === undefined) throw new Error('expected an operation');
    expect(describeStructureOp(op)).toBe('rename "Architecture" to "Arch", move under "Design"');
  });

  it('names the top of the space rather than a null parent', () => {
    // A mirror with no root page (a space with no home page): a note directly in the
    // mount is a top-level page, so moving one there sets its parent to nothing.
    const result = plan({
      remote: [ref('1', 'Architecture', '9')],
      local: [note('EP/Architecture.md', '1')],
      state: state(tracked({ pageId: '1', parentId: '9' })),
      rootPageId: null,
    });

    const op = result.ops[0];
    if (op === undefined) throw new Error('expected an operation');
    expect(describeStructureOp(op)).toBe('move under the top of the space');
  });
});

describe('retargetPulls', () => {
  function pullItem(pageId: string, path: string): PullItem {
    return {
      page: ref(pageId, 'Architecture'),
      path,
      isFolderNote: false,
      isNew: false,
      alias: null,
      previousAlias: null,
      previousLabels: [],
    };
  }

  it('writes a locally renamed page where its file actually is', () => {
    // Writing to the remote-derived path would create a *second* note for one page.
    const items = retargetPulls({
      pull: [pullItem('1', 'EP/Architecture.md')],
      relocate: [],
      suppressRelocate: new Set(),
      local: [note('EP/Architecture v2.md', '1')],
    });

    expect(items[0]?.path).toBe('EP/Architecture v2.md');
  });

  it('leaves a page this sync is relocating alone', () => {
    // The relocate runs first and puts the file exactly where the pull expects it, so
    // the scanned path is the stale one here.
    const items = retargetPulls({
      pull: [pullItem('1', 'EP/Moved/Architecture.md')],
      relocate: [{ pageId: '1' }],
      suppressRelocate: new Set(),
      local: [note('EP/Architecture.md', '1')],
    });

    expect(items[0]?.path).toBe('EP/Moved/Architecture.md');
  });

  it('redirects a page whose relocate was suppressed', () => {
    const items = retargetPulls({
      pull: [pullItem('1', 'EP/Moved/Architecture.md')],
      relocate: [{ pageId: '1' }],
      suppressRelocate: new Set(['1']),
      local: [note('EP/Architecture.md', '1')],
    });

    expect(items[0]?.path).toBe('EP/Architecture.md');
  });

  it('leaves an ordinary pull untouched', () => {
    const items = retargetPulls({
      pull: [pullItem('1', 'EP/Architecture.md')],
      relocate: [],
      suppressRelocate: new Set(),
      local: [note('EP/Architecture.md', '1')],
    });

    expect(items[0]?.path).toBe('EP/Architecture.md');
  });
});
