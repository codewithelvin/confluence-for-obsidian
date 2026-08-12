import type { ConfluencePageRef } from '../api/api-types';
import type { MappedPage, PathMap, UnmappablePage } from '../vault/path-mapper';
import { parentPath } from '../vault/vault-gateway';
import type { ScannedNote } from '../vault/vault-gateway';
import type { PageState, SubscriptionState } from './sync-state';

/**
 * Pull classification (spec §6.6.2 steps 3–4, §6.6.3).
 *
 * Pure: it takes what the remote reports, what the vault holds and what the
 * index remembers, and returns what should happen. Nothing here performs I/O,
 * which is what lets every branch — conflicts, orphans, remote deletions — be
 * tested without a network or a file system.
 */

/** A page the plan refers to by its local file. */
export interface LocalPage {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
}

export interface PullItem {
  readonly page: ConfluencePageRef;
  readonly path: string;
  readonly isFolderNote: boolean;
  readonly isNew: boolean;
  /** Title to hold in `aliases` because the file name is not it (FR-4.11). */
  readonly alias: string | null;
  /** Alias written last time, so a retitled page does not leave a stale one behind. */
  readonly previousAlias: string | null;
  /**
   * Labels written into `tags` last time (FR-9.1).
   *
   * Carried on the item for the same reason `previousAlias` is: the executor
   * writes notes and must not also be the thing that reads the index, or the two
   * disagree about what the plugin owns and it starts removing the user's tags.
   */
  readonly previousLabels: readonly string[];
}

export interface MoveOp {
  readonly from: string;
  readonly to: string;
}

export interface RelocateItem {
  readonly pageId: string;
  readonly title: string;
  /** Applied in order; a folder move carries the page's children with it. */
  readonly moves: readonly MoveOp[];
  readonly to: string;
  readonly isFolderNote: boolean;
}

export interface PullPlan {
  /** Pages whose body must be fetched and written. */
  readonly pull: readonly PullItem[];
  /** Remote-driven moves and renames (FR-3.6, FR-3.7). */
  readonly relocate: readonly RelocateItem[];
  /** Tracked pages that no longer exist remotely (FR-3.5). Confirmed before applying. */
  readonly deleteLocal: readonly LocalPage[];
  /**
   * Tracked pages that are gone remotely *and* whose note is already gone.
   *
   * Nothing to delete and nothing to confirm — only an index entry to drop. Kept
   * apart from `deleteLocal` so the confirmation prompt never lists a file the
   * user would not find.
   */
  readonly forget: readonly string[];
  /** Tracked pages whose local file is gone. Reported, never deleted remotely (D6). */
  readonly orphans: readonly LocalPage[];
  /** Changed on both sides. Read-only sync leaves them untouched; M5 resolves them. */
  readonly conflicts: readonly LocalPage[];
  /** Changed locally only — waiting for the push path (M5). */
  readonly localEdits: readonly LocalPage[];
  /** Markdown files in the mount with no Confluence identity. */
  readonly untracked: readonly string[];
  readonly unmappable: readonly UnmappablePage[];
  /** Pages whose file name had to be shortened to fit the path budget (§6.5.3). */
  readonly truncated: readonly LocalPage[];
  readonly unchanged: number;
}

export interface PlanInput {
  readonly remote: readonly ConfluencePageRef[];
  readonly local: readonly ScannedNote[];
  readonly state: SubscriptionState;
  readonly paths: PathMap;
  /**
   * Pages whose comments changed since the last sync (§16 O16).
   *
   * Their bodies have not moved, so nothing else in this plan would look at them —
   * but FR-9.4 rebuilds the comments region as part of writing a body, so the only
   * way to show a new remark is to pull the page again.
   *
   * Absent on a first sync and whenever the subscription has comments switched off
   * (FR-9.5), which is why it is optional rather than an empty set the caller has to
   * remember to pass.
   */
  readonly commentsChanged?: ReadonlySet<string>;
}

/**
 * Moves that take a page from where it is to where it belongs.
 *
 * A folder note is moved by its folder first, so its children travel with it in
 * one operation instead of one per descendant; the note inside is then renamed
 * if the title also changed.
 */
function movesFor(previous: PageState, mapped: MappedPage): MoveOp[] {
  const moves: MoveOp[] = [];
  let notePath = previous.localPath;

  if (previous.isFolderNote) {
    const from = parentPath(previous.localPath);
    const to = mapped.folderPath ?? parentPath(mapped.notePath);
    if (from !== to) {
      moves.push({ from, to });
      notePath = `${to}/${previous.localPath.slice(from.length + 1)}`;
    }
  }

  if (notePath !== mapped.notePath) moves.push({ from: notePath, to: mapped.notePath });
  return moves;
}

interface Buckets {
  readonly pull: PullItem[];
  readonly relocate: RelocateItem[];
  readonly deleteLocal: LocalPage[];
  readonly orphans: LocalPage[];
  readonly conflicts: LocalPage[];
  readonly localEdits: LocalPage[];
  readonly truncated: LocalPage[];
}

function emptyBuckets(): Buckets {
  return {
    pull: [],
    relocate: [],
    deleteLocal: [],
    orphans: [],
    conflicts: [],
    localEdits: [],
    truncated: [],
  };
}

function toLocalPage(page: { id: string; title: string }, path: string): LocalPage {
  return { pageId: page.id, title: page.title, path };
}

/**
 * Classifies one page that exists both remotely and in the index.
 *
 * Returns whether it counted as unchanged, so the caller can report a number
 * rather than a list of several hundred untouched pages.
 */
function classifyTracked(
  page: ConfluencePageRef,
  previous: PageState,
  mapped: MappedPage,
  scanned: ScannedNote | undefined,
  buckets: Buckets,
  commentsChanged: boolean,
): boolean {
  if (scanned === undefined) {
    buckets.orphans.push(toLocalPage(page, previous.localPath));
    return false;
  }

  const remoteChanged = page.version !== previous.remoteVersion;
  const locallyChanged = scanned.hash !== previous.localHash;

  // A new comment is deliberately *not* part of this test. FR-6.1 defines a conflict
  // as a local edit against a moved remote version, and a colleague's remark moves no
  // version — treating it as one would interrupt the user to resolve nothing.
  if (remoteChanged && locallyChanged) {
    buckets.conflicts.push(toLocalPage(page, scanned.path));
    return false;
  }

  const moves = movesFor(previous, mapped);
  if (moves.length > 0) {
    buckets.relocate.push({
      pageId: page.id,
      title: page.title,
      moves,
      to: mapped.notePath,
      isFolderNote: mapped.folderPath !== null,
    });
  }

  if (remoteChanged) {
    buckets.pull.push(pullOf(page, previous, mapped));
    return false;
  }
  if (locallyChanged) {
    buckets.localEdits.push(toLocalPage(page, scanned.path));
    return false;
  }
  // Last, and only when the note is untouched: a pull rewrites the body, and doing
  // that to a note the user has edited would discard their work to show a remark.
  if (commentsChanged) {
    buckets.pull.push(pullOf(page, previous, mapped));
    return false;
  }
  return moves.length === 0;
}

/** A pull of a page already in the index — the same item whatever prompted it. */
function pullOf(page: ConfluencePageRef, previous: PageState, mapped: MappedPage): PullItem {
  return {
    page,
    path: mapped.notePath,
    isFolderNote: mapped.folderPath !== null,
    isNew: false,
    alias: mapped.aliasTitle,
    previousAlias: previous.alias,
    previousLabels: previous.labels,
  };
}

/** Markdown files in the mount that no tracked or incoming page accounts for. */
function untrackedNotes(
  input: PlanInput,
  remote: ReadonlyMap<string, ConfluencePageRef>,
): string[] {
  return input.local
    .filter((note) => {
      const id = note.identity?.id;
      return id === undefined || !(remote.has(id) || id in input.state.pages);
    })
    .map((note) => note.path);
}

export function buildPullPlan(input: PlanInput): PullPlan {
  const buckets = emptyBuckets();
  const remote = new Map(input.remote.map((page) => [page.id, page]));

  // A "Save Both" snapshot is not a page (FR-6.4). Dropped before anything else
  // looks at the scan, so it can be neither matched to an identity nor reported
  // as an untracked candidate.
  const local = input.local.filter((note) => !note.isConflictCopy);
  const scoped: PlanInput = { ...input, local };

  // Located by identity rather than by path: a note the user moved is still the
  // same page, and matching on path alone would report it as both an orphan and
  // an untracked file.
  const scanned = new Map(
    local.flatMap((note) => (note.identity === null ? [] : [[note.identity.id, note]])),
  );

  let unchanged = 0;
  for (const page of input.remote) {
    const mapped = input.paths.byId.get(page.id);
    if (mapped === undefined) continue; // Reported through `unmappable`.

    if (mapped.truncated) buckets.truncated.push(toLocalPage(page, mapped.notePath));

    const previous = input.state.pages[page.id];
    if (previous === undefined) {
      buckets.pull.push({
        page,
        path: mapped.notePath,
        isFolderNote: mapped.folderPath !== null,
        isNew: true,
        alias: mapped.aliasTitle,
        previousAlias: null,
        previousLabels: [],
      });
      continue;
    }
    const withNewComments = input.commentsChanged?.has(page.id) ?? false;
    if (classifyTracked(page, previous, mapped, scanned.get(page.id), buckets, withNewComments)) {
      unchanged += 1;
    }
  }

  const forget: string[] = [];
  for (const [pageId, previous] of Object.entries(input.state.pages)) {
    if (remote.has(pageId)) continue;
    const note = scanned.get(pageId);
    if (note === undefined) forget.push(pageId);
    else buckets.deleteLocal.push({ pageId, title: previous.title, path: note.path });
  }

  // Parents first: moving a folder carries its children, so a child's own move
  // is already done by the time its turn comes.
  const relocate = [...buckets.relocate].sort(
    (a, b) => (a.moves[0]?.from.length ?? 0) - (b.moves[0]?.from.length ?? 0),
  );

  return {
    ...buckets,
    relocate,
    forget,
    untracked: untrackedNotes(scoped, remote),
    unmappable: input.paths.unmappable,
    unchanged,
  };
}
