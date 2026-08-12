import type { ConfluenceCommentRef, ConfluencePageRef } from '../api/api-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import type { SyncRequest } from './sync-engine';
import type { SyncCallbacks } from './sync-types';

/**
 * The steps a sync takes before it decides anything (spec §6.6.2 steps 1–2, §16 O16).
 *
 * Free functions rather than methods: none reads the engine's own state, all are
 * about the *request*, and keeping them here leaves the engine reading as §6.6.2's
 * algorithm rather than as that algorithm plus its preliminaries.
 */

/** Verifies credentials and version before anything is written (§6.6.2 step 1). */
export async function preflight(
  request: SyncRequest,
  callbacks: SyncCallbacks,
): Promise<Result<void, AppError>> {
  callbacks.onProgress?.({
    phase: 'preflight',
    done: 0,
    total: null,
    detail: 'Checking the connection',
  });

  const check = await request.client.checkConnection();
  if (!check.ok) return check;

  if (!check.value.versionSupported) {
    return err(
      new AppError(
        'VERSION_UNSUPPORTED',
        `This Confluence is version ${check.value.version?.raw ?? 'unknown'}. Personal Access ` +
          'Tokens need Data Center 7.9 or newer, so this connection cannot be synced.',
        { action: 'open-docs' },
      ),
    );
  }
  return ok(undefined);
}

export async function discover(
  request: SyncRequest,
  callbacks: SyncCallbacks,
): Promise<Result<readonly ConfluencePageRef[], AppError>> {
  callbacks.onProgress?.({
    phase: 'discovering',
    done: 0,
    total: null,
    detail: request.subscription.spaceKey,
  });

  const options = {
    onProgress: (collected: number) => {
      callbacks.onProgress?.({
        phase: 'discovering',
        done: collected,
        total: null,
        detail: `${String(collected)} pages found`,
      });
    },
    ...(callbacks.isCancelled === undefined ? {} : { isCancelled: callbacks.isCancelled }),
  };

  return request.client.listSubtree(
    request.subscription.spaceKey,
    request.subscription.rootPageId,
    options,
  );
}

/**
 * The pages a comment has been added to or edited on since the last sync (§16 O16).
 *
 * Pure, and separate from the request that feeds it, because the whole subtlety is
 * here: the query reaches back a margin to survive the server's timezone being
 * unknown, so the results have to be narrowed again by each comment's own absolute
 * timestamp. A comment whose timestamp the instance did not report is kept — one
 * unnecessary page pull is a better answer than a remark nobody sees.
 */
export function pagesWithNewComments(
  comments: readonly ConfluenceCommentRef[],
  since: string,
): ReadonlySet<string> {
  const cutoff = Date.parse(since);
  if (Number.isNaN(cutoff)) return new Set();

  return new Set(
    comments.flatMap((comment) => {
      const at = Date.parse(comment.updatedAt);
      return Number.isNaN(at) || at > cutoff ? [comment.pageId] : [];
    }),
  );
}

/**
 * Asks which pages have new comments, and never fails a sync over the answer.
 *
 * This is an addition to what a sync already did correctly: without it comments
 * arrive whenever the page next changes, which is FR-9.4's wording met but not its
 * intent. A server that refuses the query — an older Data Center, a CQL the instance
 * dislikes — should therefore leave the sync exactly as it was, not stop it.
 *
 * Skipped entirely on a first sync: with no `since` every comment in the space
 * matches, and every page is being pulled anyway.
 */
export async function discoverCommentChanges(
  request: SyncRequest,
  since: string | null,
  logger: Logger,
): Promise<ReadonlySet<string>> {
  if (!request.subscription.syncComments || since === null) return new Set();

  const changed = await request.client.listChangedComments(request.subscription.spaceKey, since);
  if (!changed.ok) {
    logger.warn(`Could not check for new comments: ${changed.error.userMessage}`);
    return new Set();
  }

  const pages = pagesWithNewComments(changed.value, since);
  if (pages.size > 0) logger.debug(`${String(pages.size)} page(s) have new comments.`);
  return pages;
}
