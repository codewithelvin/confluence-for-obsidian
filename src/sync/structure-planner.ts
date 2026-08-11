import type { ConfluencePageRef } from '../api/api-types';
import { parentPath, type ScannedNote } from '../vault/vault-gateway';
import type { SubscriptionState } from './sync-state';
import {
  baseName,
  folderRename,
  parentChange,
  titleChange,
  titleOf,
  wouldCycle,
  type Candidate,
  type Refusal,
} from './structure-rules';

/**
 * Local-driven structure (spec §6.6.2 step 4, FR-7.5 to FR-7.9).
 *
 * The whole difficulty of M6 is in one distinction. A note whose location no longer
 * matches the remote tree is *either* a page somebody moved in Confluence — which
 * must move the file (FR-3.6) — *or* a page the user dragged in Obsidian, which must
 * move the page (FR-7.5). Acting on the wrong reading either drags the user's file
 * back where they moved it from, or reorganises a corporate wiki nobody asked to
 * reorganise.
 *
 * What tells them apart is the **index**, which records where both sides stood at
 * the last sync:
 *
 *   remote.parentId ≠ state.parentId → the remote moved  → RELOCATE (M3, FR-3.6)
 *   local folder    ≠ state.parentId → the user moved    → STRUCTURE (FR-7.5)
 *   both                                                 → refused, reported
 *
 * The same three-way reading applies to the title. Pure, like the pull planner:
 * nothing here performs I/O, so every branch is testable without a vault.
 */

/** A page whose title must change in Confluence to match its file name (FR-7.6). */
export interface TitleChange {
  readonly from: string;
  readonly to: string;
}

/** A page whose parent must change in Confluence to match its folder (FR-7.5). */
export interface ParentChange {
  readonly from: string | null;
  readonly to: string | null;
  /** The new parent's title, for the preview. `null` at the top of the space. */
  readonly toTitle: string | null;
}

/**
 * One page's structural change, whatever combination it is.
 *
 * A rename and a move on the same page are one operation, not two: they are one
 * `PUT`, and presenting them separately would ask the user to confirm twice for a
 * single drag.
 */
export interface StructureOp {
  readonly pageId: string;
  /** Where the note is *now* — the user's placement, which is the authority. */
  readonly notePath: string;
  readonly isFolderNote: boolean;
  readonly title: TitleChange | null;
  readonly parent: ParentChange | null;
  /**
   * A folder-note folder whose name no longer matches its note, to be corrected
   * locally before the remote call (FR-7.6).
   *
   * The file name is authoritative, so this renames the *folder*, never the note.
   */
  readonly folderRename: { readonly from: string; readonly to: string } | null;
}

/** Something the user did that cannot be carried out, with the reason (FR-7.7–7.9). */
export interface RejectedStructure {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  readonly reason: string;
}

export interface StructurePlan {
  readonly ops: readonly StructureOp[];
  readonly rejected: readonly RejectedStructure[];
  /**
   * Pages the pull plan must leave alone this sync.
   *
   * A page that moved on both sides is refused here, and letting the remote-driven
   * relocate run anyway would apply half of a change the user was told was refused.
   */
  readonly suppressRelocate: ReadonlySet<string>;
}

export const EMPTY_STRUCTURE: StructurePlan = {
  ops: [],
  rejected: [],
  suppressRelocate: new Set(),
};

export interface StructureInput {
  readonly remote: readonly ConfluencePageRef[];
  readonly local: readonly ScannedNote[];
  readonly state: SubscriptionState;
  readonly mountPath: string;
  /** The page that collapses into the mount (D13), exempt from FR-7.6. */
  readonly rootPageId: string | null;
}

/**
 * Which page owns each folder in the mount, so a note's parent can be read off its
 * location (§6.5: "parenthood is derived from the enclosing folder's folder-note").
 *
 * Built from the index's `isFolderNote` against the *scanned* path rather than from
 * the path's shape, so a folder-note whose folder the user renamed still owns that
 * folder. Reading the shape instead would make every note inside it parentless for
 * one sync and refuse a move the user did not make.
 */
function folderOwners(
  input: StructureInput,
  byId: ReadonlyMap<string, ScannedNote>,
): Map<string, string> {
  const owners = new Map<string, string>();

  // The mount is the root page's folder (D13). Registered first so a stray
  // folder-note claiming the mount cannot displace it.
  if (input.rootPageId !== null) owners.set(input.mountPath, input.rootPageId);

  for (const [pageId, note] of byId) {
    if (input.state.pages[pageId]?.isFolderNote !== true) continue;

    const folder = parentPath(note.path);
    if (folder === input.mountPath && input.rootPageId !== null) continue;
    if (!owners.has(folder)) owners.set(folder, pageId);
  }
  return owners;
}

/**
 * The page a note now sits under, or `undefined` when its folder belongs to no page.
 *
 * A **folder note** is read one level higher. `EP/Arch/Architecture.md` *is* the note
 * of the folder `EP/Arch`, so the page it sits under is whoever owns `EP` — reading
 * its own folder would make every folder note in the mirror its own parent, and
 * propose moving each page inside itself.
 *
 * `undefined` is not "top level": a note dropped into a plain folder the user made
 * has no expressible parent, and guessing the nearest ancestor would place the page
 * somewhere the folder structure does not show, then move the file back out on the
 * next sync.
 */
function localParentOf(
  path: string,
  isFolderNote: boolean,
  input: StructureInput,
  owners: ReadonlyMap<string, string>,
): string | null | undefined {
  const own = parentPath(path);
  const folder = isFolderNote ? parentPath(own) : own;

  if (folder === input.mountPath) return input.rootPageId;
  if (folder.length === 0) return null;

  const owner = owners.get(folder);
  return owner ?? undefined;
}

/**
 * Reads the user's structural intent off the vault.
 *
 * Deliberately conservative: anything it cannot express exactly comes back in
 * `rejected` and produces no request at all. FR-7.8's preview is only meaningful if
 * everything in `ops` is something the plugin will actually do.
 */
export function buildStructurePlan(input: StructureInput): StructurePlan {
  const remoteById = new Map(input.remote.map((page) => [page.id, page]));
  const byId = new Map(
    input.local.flatMap((note) =>
      note.isConflictCopy || note.identity === null ? [] : [[note.identity.id, note] as const],
    ),
  );

  const owners = folderOwners(input, byId);
  const parents = new Map<string, string | null>(
    input.remote.map((page) => [page.id, page.parentId]),
  );
  const titleFor = (pageId: string): string | null => remoteById.get(pageId)?.title ?? null;

  const ops: StructureOp[] = [];
  const rejected: RejectedStructure[] = [];
  const suppressRelocate = new Set<string>();

  // Sorted by path so the plan — and its preview — is the same on every machine
  // whatever order the scan happened to return.
  for (const [pageId, note] of [...byId].sort(([, a], [, b]) => (a.path < b.path ? -1 : 1))) {
    const previous = input.state.pages[pageId];
    const remote = remoteById.get(pageId);
    if (previous === undefined || remote === undefined) continue;

    const candidate: Candidate = {
      note,
      previous,
      remote,
      localTitle: titleOf(note.path),
      localParent: localParentOf(note.path, previous.isFolderNote, input, owners),
    };

    const read = classify(candidate, pageId === input.rootPageId, titleFor, parents);
    if (read.refusal !== undefined) {
      rejected.push({
        pageId,
        title: previous.title,
        path: note.path,
        reason: read.refusal.reason,
      });
      // Only the both-sides kind stops the remote half. Applying it after telling the
      // user their change was refused would move their file anyway.
      if (read.refusal.conflict) suppressRelocate.add(pageId);
      continue;
    }
    if (read.op === null) continue;

    if (read.op.parent !== null) parents.set(pageId, read.op.parent.to);
    ops.push(read.op);
  }

  return { ops, rejected, suppressRelocate };
}

/**
 * One note's whole reading: the operation it needs, nothing, or a refusal.
 *
 * The cycle check runs against `parents`, which already carries the moves accepted
 * before this one — so two drags that are each innocent but jointly circular are
 * caught too (FR-7.9).
 */
function classify(
  candidate: Candidate,
  isRoot: boolean,
  titleFor: (pageId: string) => string | null,
  parents: ReadonlyMap<string, string | null>,
): { readonly op: StructureOp | null; readonly refusal?: Refusal } {
  const { previous, note } = candidate;
  const title = titleChange(candidate, isRoot);
  const parent = parentChange(candidate, isRoot, titleFor);

  const cycles: Refusal | undefined =
    parent.change !== null && wouldCycle(previous.pageId, parent.change.to, parents)
      ? { conflict: false, reason: 'moving it there would put the page inside itself.' }
      : undefined;

  const refusal = title.refusal ?? parent.refusal ?? cycles;
  if (refusal !== undefined) return { op: null, refusal };

  const folder = folderRename(candidate, isRoot);
  if (title.change === null && parent.change === null && folder === null) return { op: null };

  return {
    op: {
      pageId: previous.pageId,
      notePath: note.path,
      isFolderNote: previous.isFolderNote,
      title: title.change,
      parent: parent.change,
      folderRename: folder,
    },
  };
}

/** One line per operation, for FR-7.8's confirmation. */
export function describeStructureOp(op: StructureOp): string {
  const parts: string[] = [];

  if (op.title !== null) parts.push(`rename "${op.title.from}" to "${op.title.to}"`);
  if (op.parent !== null) {
    parts.push(
      `move under ${op.parent.toTitle === null ? 'the top of the space' : `"${op.parent.toTitle}"`}`,
    );
  }
  if (op.folderRename !== null)
    parts.push(`rename its folder to "${baseName(op.folderRename.to)}"`);

  return parts.join(', ');
}
