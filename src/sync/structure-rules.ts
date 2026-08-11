import type { ConfluencePageRef } from '../api/api-types';
import { parentPath, type ScannedNote } from '../vault/vault-gateway';
import type { PageState } from './sync-state';
import type { ParentChange, TitleChange } from './structure-planner';

/**
 * The rules that decide one page's structural change (spec FR-7.5, FR-7.6, FR-7.9).
 *
 * Split from the planner so that file reads as the *walk* — which notes to look at and
 * in what order — while this one holds the three-way reading each note gets: the user
 * changed it, Confluence changed it, or both did and it is refused.
 */

/** A note's title, as its file name states it. */
export function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** Last segment of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether making `parentId` the parent of `pageId` would put the page inside itself
 * (FR-7.9).
 *
 * Walked against the parentage the sync will *end* with — the remote tree plus the
 * moves already accepted — so two drags that are each innocent but jointly circular
 * are caught as well. Rejected client-side: Confluence answers such a request with
 * a 400 whose message says nothing a user could act on.
 */
export function wouldCycle(
  pageId: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  let current = parentId;
  const seen = new Set<string>();

  while (current !== null && current !== undefined) {
    if (current === pageId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}

export interface Candidate {
  readonly note: ScannedNote;
  readonly previous: PageState;
  readonly remote: ConfluencePageRef;
  readonly localTitle: string;
  readonly localParent: string | null | undefined;
}

/**
 * A refusal, and whether it is the *both-sides* kind.
 *
 * The distinction decides whether the remote-driven relocate may still run. A change
 * refused because both sides moved must stop it — the user has been told nothing
 * happened. A change refused for any other reason has no bearing on the remote half,
 * which is a perfectly good change on its own.
 */
export interface Refusal {
  readonly reason: string;
  readonly conflict: boolean;
}

/** The title change this page needs, or a reason it cannot have one. */
export function titleChange(
  candidate: Candidate,
  isRoot: boolean,
): { change: TitleChange | null; refusal?: Refusal } {
  const { localTitle, previous, remote } = candidate;
  if (localTitle === previous.title) return { change: null };

  // The mount's folder note is the one note whose name is not its title: the folder
  // belongs to the user (D13), so FR-7.6 must not push its name to Confluence.
  if (isRoot) return { change: null };

  if (remote.title !== previous.title) {
    return {
      change: null,
      refusal: {
        conflict: true,
        reason:
          `renamed here to "${localTitle}" and renamed in Confluence to "${remote.title}". ` +
          'Sync to take the Confluence title, or rename it again afterwards to keep yours.',
      },
    };
  }
  return { change: { from: previous.title, to: localTitle } };
}

/** The parent change this page needs, or a reason it cannot have one. */
export function parentChange(
  candidate: Candidate,
  isRoot: boolean,
  titleFor: (pageId: string) => string | null,
): { change: ParentChange | null; refusal?: Refusal } {
  const { localParent, previous, remote } = candidate;
  if (localParent === previous.parentId) return { change: null };

  // The root page's parent lives outside the subscription, so its folder says
  // nothing about it (D13).
  if (isRoot) return { change: null };

  if (localParent === undefined) {
    return {
      change: null,
      refusal: {
        conflict: false,
        reason:
          'its folder is not a Confluence page, so there is no page to move it under. ' +
          'Move it into a folder that holds a page note of the same name.',
      },
    };
  }
  if (remote.parentId !== previous.parentId) {
    return {
      change: null,
      refusal: {
        conflict: true,
        reason:
          'moved here and moved in Confluence. Sync first, then move it again if you still want to.',
      },
    };
  }
  return {
    change: {
      from: previous.parentId,
      to: localParent,
      toTitle: localParent === null ? null : titleFor(localParent),
    },
  };
}

/**
 * A folder-note whose folder name no longer matches its note (FR-7.6).
 *
 * The note's name wins, so the folder is renamed. The mount is exempt: that folder's
 * name is the user's own (D13).
 */
export function folderRename(
  candidate: Candidate,
  isRoot: boolean,
): { readonly from: string; readonly to: string } | null {
  if (isRoot || !candidate.previous.isFolderNote) return null;

  const folder = parentPath(candidate.note.path);
  if (folder.length === 0 || baseName(folder) === candidate.localTitle) return null;

  return { from: folder, to: `${parentPath(folder)}/${candidate.localTitle}` };
}
