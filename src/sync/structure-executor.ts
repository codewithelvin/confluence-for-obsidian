import type { ConfluenceGateway } from '../api/confluence-client';
import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import type { Logger } from '../util/logger';
import { pageUrl, type ConfluenceIdentity } from '../vault/frontmatter';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import { baseName } from './structure-rules';
import type { StructureOp } from './structure-planner';
import type { PageState } from './sync-state';
import type { SyncFailure } from './sync-types';

/**
 * Carrying out a confirmed structural change (spec FR-7.5, FR-7.6, §6.6.2 step 6c).
 *
 * Local half first, remote second, and that order is deliberate: the local half is
 * the folder rename FR-7.6 asks for, and doing it after a successful `PUT` would
 * leave a page correctly retitled in Confluence beside a folder still carrying the
 * old name. A local rename that fails first costs nothing — the page has not moved.
 */

export interface StructureDeps {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly logger: Logger;
  readonly baseUrl: string;
  readonly spaceKey: string;
  readonly now: () => string;
}

export interface StructureOutcome {
  /** Index records for every page this changed, to persist with the rest of the sync. */
  readonly states: readonly PageState[];
  readonly applied: number;
  readonly failures: readonly SyncFailure[];
}

/** What Confluence reported after a structural write. */
interface Sent {
  readonly version: number;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * Sends the title and parent the user's layout implies.
 *
 * The page is read immediately before the write for two reasons that both matter.
 * Its version is needed — Confluence accepts an update only at exactly one past the
 * current one — and so is its **body**, which is sent back unchanged: a structural
 * `PUT` must not be the thing that decides what a page says. A colleague's edit from
 * a minute ago therefore survives a move, and is not a conflict for it either.
 * Moving a page is not an opinion about its contents.
 */
async function sendChange(
  deps: StructureDeps,
  op: StructureOp,
  state: PageState,
): Promise<Sent | AppError> {
  const remote = await deps.client.getPage(op.pageId);
  if (!remote.ok) return remote.error;

  const title = op.title?.to ?? remote.value.title;

  const updated = await deps.client.updatePage({
    id: op.pageId,
    title,
    spaceKey: deps.spaceKey,
    parentId: op.parent === null ? state.parentId : op.parent.to,
    version: remote.value.version + 1,
    storage: remote.value.storage,
  });
  if (!updated.ok) return updated.error;

  return {
    version: updated.value.version,
    title,
    updatedAt: updated.value.updatedAt,
    updatedBy: updated.value.updatedBy,
  };
}

/** A folder rename as it is about to be carried out. */
interface FolderRename {
  readonly from: string;
  readonly to: string;
}

/**
 * Where this page's note is **now**.
 *
 * `op.notePath` was read from a scan taken before any of this sync's changes ran, and
 * an operation applied earlier can already have moved the file: renaming the folder
 * note of `EP/Design` carries everything below it, so a second operation on a page
 * inside that folder finds `op.notePath` naming somewhere that no longer exists.
 *
 * The planned path is checked first because it is almost always still right, and
 * `locateIdentity` walks every note in the vault — paying that per operation would make
 * a batch of twenty confirmed moves twenty passes over the mirror. The check is that the
 * note *there* is still this page's, not merely that something is: after a rename two
 * operations can have exchanged paths, and writing one page's identity block over
 * another's would be worse than the stale path this exists to avoid.
 */
function currentPath(deps: StructureDeps, op: StructureOp): string {
  if (deps.vault.readIdentity(op.notePath)?.id === op.pageId) return op.notePath;
  return deps.vault.locateIdentity(op.pageId) ?? op.notePath;
}

/**
 * The folder rename still outstanding, measured against where the note is now.
 *
 * The *name* the folder must take is the note's own and cannot go stale — it is the
 * file name the user chose. Where that folder currently sits can, so it is read off
 * the live path rather than taken from the plan. `null` means there is nothing left to
 * do, which is the ordinary answer once an ancestor's rename has already carried this
 * folder along.
 */
function folderRenameFor(op: StructureOp, notePath: string): FolderRename | null {
  if (op.folderRename === null) return null;

  const folder = parentPath(notePath);
  if (folder.length === 0) return null;

  const to = `${parentPath(folder)}/${baseName(op.folderRename.to)}`;
  return folder === to ? null : { from: folder, to };
}

/**
 * Renames a folder-note's folder to match its note (FR-7.6), answering with the
 * note's path afterwards.
 *
 * Through `vault.move`, which is `fileManager.renameFile` underneath, so every
 * wikilink pointing into the folder — including the user's own — is rewritten by
 * Obsidian rather than left dangling.
 */
async function renameFolder(
  deps: StructureDeps,
  rename: FolderRename,
  notePath: string,
): Promise<string | AppError> {
  const moved = await deps.vault.move(rename.from, rename.to);
  if (!moved.ok) return moved.error;

  return `${rename.to}/${notePath.slice(rename.from.length + 1)}`;
}

/**
 * Rewrites the note's identity block, dropping an alias a retitle has made stale.
 *
 * A retitle makes the file name and the title equal by construction — the new title
 * *came from* the file name — so any alias the plugin was holding now points at a
 * title that no longer exists, and would send the quick switcher nowhere.
 */
async function writeIdentity(
  deps: StructureDeps,
  op: StructureOp,
  state: PageState,
  notePath: string,
  sent: Sent,
): Promise<string | AppError> {
  const identity: ConfluenceIdentity = {
    id: op.pageId,
    space: deps.spaceKey,
    version: sent.version,
    parent: op.parent === null ? state.parentId : op.parent.to,
    url: pageUrl(deps.baseUrl, op.pageId),
    updated: sent.updatedAt,
    updatedBy: sent.updatedBy,
    fidelity: state.fidelity,
  };

  const written = await deps.vault.updateIdentity(
    notePath,
    identity,
    op.title === null ? undefined : { next: null, previous: state.alias },
  );
  return written.ok ? written.value : written.error;
}

/** One operation carried out: the page's new record, and the folder move it made. */
interface Applied {
  readonly state: PageState;
  /** `null` when no folder moved, so descendants need no patching. */
  readonly rename: FolderRename | null;
}

/** Applies one operation and answers with the page's new index record. */
async function applyOne(
  deps: StructureDeps,
  op: StructureOp,
  state: PageState,
): Promise<Applied | AppError> {
  const found = currentPath(deps, op);
  const rename = folderRenameFor(op, found);

  let notePath = found;
  if (rename !== null) {
    const moved = await renameFolder(deps, rename, found);
    if (moved instanceof AppError) return moved;
    notePath = moved;
  }

  // A folder correction on its own changes nothing Confluence knows about: the title
  // and the parent are both already what the page holds. Sending the `PUT` anyway
  // would add a version to the page's history whose diff is empty — history noise in
  // a corporate wiki, in return for nothing.
  if (op.title === null && op.parent === null) {
    deps.logger.debug(`Structure: renamed a folder locally; ${op.pageId} is unchanged remotely.`);
    return { state: { ...state, localPath: notePath, lastSyncedAt: deps.now() }, rename };
  }

  const sent = await sendChange(deps, op, state);
  if (sent instanceof AppError) return sent;

  const written = await writeIdentity(deps, op, state, notePath, sent);
  if (written instanceof AppError) return written;

  deps.logger.debug(`Structure: ${op.pageId} is now "${sent.title}" at ${notePath}.`);

  return {
    state: {
      ...state,
      title: sent.title,
      parentId: op.parent === null ? state.parentId : op.parent.to,
      localPath: notePath,
      remoteVersion: sent.version,
      alias: op.title === null ? state.alias : null,
      localHash: await sha256(written),
      lastSyncedAt: deps.now(),
    },
    rename,
  };
}

/**
 * Follows a folder rename through to the pages *inside* it.
 *
 * Renaming `Architecture/` carries its children with it, so their recorded paths are
 * wrong the moment the folder moves. Left alone they would self-heal on the next
 * sync — as a "moved" entry in a report about a move nobody made — so they are
 * patched here instead, where the reason is known.
 */
function followDescendants(
  pages: Readonly<Record<string, PageState>>,
  changed: ReadonlyMap<string, PageState>,
  renames: readonly FolderRename[],
): readonly PageState[] {
  if (renames.length === 0) return [];

  const followed: PageState[] = [];
  for (const [pageId, state] of Object.entries(pages)) {
    if (changed.has(pageId)) continue;

    const moved = relocated(state.localPath, renames);
    if (moved === state.localPath) continue;

    followed.push({ ...state, localPath: moved });
  }
  return followed;
}

/**
 * A path carried through every rename that applies to it, in the order they ran.
 *
 * All of them, not the first match: renaming `EP/Design` and then `EP/Designs/Model`
 * moves a note inside the second folder *twice*, and stopping at the first match would
 * record it under a folder that no longer exists.
 */
function relocated(path: string, renames: readonly FolderRename[]): string {
  return renames.reduce(
    (current, rename) =>
      current.startsWith(`${rename.from}/`)
        ? `${rename.to}${current.slice(rename.from.length)}`
        : current,
    path,
  );
}

/**
 * Applies every confirmed operation, ancestors before descendants.
 *
 * Ordering by folder depth puts a folder rename ahead of anything inside it, so a
 * child's path is recorded once — after the folder above it has settled — rather
 * than recorded and immediately invalidated.
 *
 * One page's failure never abandons the rest (FR-3.9): a folder that could not be
 * renamed must not cost the user the other nineteen moves they just confirmed.
 */
export async function applyStructure(
  deps: StructureDeps,
  ops: readonly StructureOp[],
  pages: Readonly<Record<string, PageState>>,
): Promise<StructureOutcome> {
  const changed = new Map<string, PageState>();
  const failures: SyncFailure[] = [];
  const renames: FolderRename[] = [];

  const ordered = [...ops].sort(
    (a, b) => parentPath(a.notePath).length - parentPath(b.notePath).length,
  );

  for (const op of ordered) {
    const state = pages[op.pageId];
    if (state === undefined) continue;

    const result = await applyOne(deps, op, state);
    if (result instanceof AppError) {
      failures.push({ pageId: op.pageId, title: state.title, error: result });
      continue;
    }

    changed.set(op.pageId, result.state);
    // The rename that actually happened, not the one that was planned: an ancestor's
    // move may already have carried this folder somewhere else.
    if (result.rename !== null) renames.push(result.rename);
  }

  return {
    states: [...changed.values(), ...followDescendants(pages, changed, renames)],
    applied: changed.size,
    failures,
  };
}
