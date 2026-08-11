import type { ConfluenceGateway } from '../api/confluence-client';
import type { Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { sanitiseFileName } from '../vault/filename-sanitiser';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import type { PageState, SyncStateStore } from './sync-state';

/**
 * Where a new page belongs — in Confluence and in the vault (spec FR-7.1, §6.5.4).
 *
 * Its own module because it answers a different question from creating or deleting.
 * Three answers live here, and each has a trap in it:
 *
 *  - the *page* a note's folder puts it under, which must be refused rather than
 *    guessed when the folder belongs to no page;
 *  - the **promotion** a leaf parent needs before it can hold a child, which has to
 *    happen through `renameFile` or every wikilink pointing at that parent breaks;
 *  - the *path* the new note takes, which follows from the parent's own placement.
 */

export interface PlacementDeps {
  readonly vault: Pick<VaultGateway, 'move'>;
  readonly state: SyncStateStore;
  readonly logger: Logger;
  /** Persists the promoted parent's record, which the caller owns. */
  readonly record: (subscriptionId: string, page: PageState) => Promise<void>;
}

/** A note's title, as its file name states it. */
function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/**
 * The page a note's folder puts it under (§6.5, FR-7.2).
 *
 * A folder that belongs to no page is refused rather than guessed at: placing the
 * page under the nearest ancestor would put it somewhere the folder structure does
 * not show, and the next sync would move the file straight back out.
 */
export function parentOfPath(
  state: SyncStateStore,
  subscription: Subscription,
  notePath: string,
): Result<string | null, AppError> {
  const folder = parentPath(notePath);

  // The folder's own note names the parent, and the mount is no exception: the root
  // page collapses into it (D13), so `<mount>/<mount>.md` is the folder note of the
  // mount and a note beside it is one of that page's children.
  //
  // Asking the *index* rather than `subscription.rootPageId` matters, because that
  // field is `null` for a whole-space subscription — the root page is the space's
  // home page, discovered at sync time. Reading the field would create every note
  // published at the mount root at the top of the space instead of under the home
  // page, several levels from where the vault shows it.
  const owner = Object.values(state.forSubscription(subscription.id).pages).find(
    (page) => page.isFolderNote && parentPath(page.localPath) === folder,
  );
  if (owner !== undefined) return ok(owner.pageId);

  // No folder note for the mount means the space genuinely has no home page (§6.5),
  // and a note directly inside it really is a top-level page.
  if (folder === subscription.mountPath) return ok(subscription.rootPageId);

  return err(
    new AppError(
      'NOT_FOUND',
      `"${folder}" is not a Confluence page, so there is no page to create this one under. ` +
        'Move the note into a folder that holds a page note of the same name.',
    ),
  );
}

/**
 * Promotes a leaf that is about to gain its first child (§6.5.4).
 *
 * The folder is created and the note moved into it with `fileManager.renameFile`, so
 * every wikilink pointing at the parent — the user's own included — is rewritten by
 * Obsidian instead of breaking. Only then can a child be placed beside it.
 */
async function promote(
  deps: PlacementDeps,
  subscription: Subscription,
  parent: PageState,
): Promise<Result<string, AppError>> {
  const folder = parent.localPath.replace(/\.md$/i, '');
  const notePath = `${folder}/${titleOf(parent.localPath)}.md`;

  const moved = await deps.vault.move(parent.localPath, notePath);
  if (!moved.ok) return moved;

  await deps.record(subscription.id, { ...parent, localPath: notePath, isFolderNote: true });
  deps.logger.debug(`Promoted ${parent.title} to a folder note for its first child.`);
  return ok(parent.pageId);
}

/**
 * Turns a chosen parent into the id Confluence needs, promoting it if it is a leaf.
 *
 * `null` is the mount's top level, which for a mirror with a root page (D13) means
 * *under the root page*, not at the top of the space: the mount folder **is** the root
 * page's folder, so a note directly inside it is one of its children.
 */
export async function resolveParent(
  deps: PlacementDeps,
  subscription: Subscription,
  parentId: string | null,
  client: Pick<ConfluenceGateway, 'spaceHomepageId'>,
): Promise<Result<string | null, AppError>> {
  if (parentId === null) {
    if (subscription.rootPageId !== null) return ok(subscription.rootPageId);

    const homepage = await client.spaceHomepageId(subscription.spaceKey);
    return homepage.ok ? ok(homepage.value) : homepage;
  }

  const parent = deps.state.forSubscription(subscription.id).pages[parentId];
  if (parent === undefined) {
    return err(new AppError('NOT_FOUND', 'That parent page is not in the sync index.'));
  }
  return parent.isFolderNote ? ok(parentId) : promote(deps, subscription, parent);
}

/**
 * Where a new page's note goes, given the parent it was created under.
 *
 * The title is sanitised for the *file name* only (§6.5.2) — the page keeps the title
 * the user asked for, and the alias carries it when the two differ.
 */
export function placeFor(
  state: SyncStateStore,
  subscription: Subscription,
  title: string,
  parentId: string | null,
): Result<string, AppError> {
  const name = sanitiseFileName(title);
  if (parentId === null || parentId === subscription.rootPageId) {
    return ok(`${subscription.mountPath}/${name}.md`);
  }

  const parent = state.forSubscription(subscription.id).pages[parentId];
  if (parent === undefined) {
    return err(new AppError('NOT_FOUND', 'That parent page is not in the sync index.'));
  }
  return ok(`${parentPath(parent.localPath)}/${name}.md`);
}
