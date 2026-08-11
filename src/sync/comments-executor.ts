import type { ConfluenceGateway } from '../api/confluence-client';
import { commentText } from '../convert/comment-text';
import type { Logger } from '../util/logger';
import type { VaultGateway } from '../vault/vault-gateway';
import { renderCommentsRegion, type RenderedComment } from './managed-regions';
import type { PullItem } from './pull-planner';
import type { SyncFailure } from './sync-types';

/**
 * Pulling a page's comments into its managed region (spec FR-9.3 to FR-9.6).
 *
 * Read-only in both senses: the region is regenerated wholesale on every pull and
 * never pushed (FR-9.4, FR-5.8), and D8 rules out authoring a comment from
 * Obsidian at all. So this only ever produces text.
 *
 * A failure here never fails the page. A note whose body arrived but whose comments
 * did not is worth far more than no note, and the next sync fetches them again.
 */

export interface CommentDeps {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly logger: Logger;
  /** The subscription's own switch (FR-9.5). Off means no page in it gets a region. */
  readonly enabled: boolean;
}

export interface CommentOutcome {
  /**
   * The region to append, or `''` for none.
   *
   * `''` is not "leave what is there": FR-9.4 regenerates the region on every
   * pull, so a page whose last comment was deleted — or a note that has just
   * opted out — loses the block it had.
   */
  readonly region: string;
  readonly comments: number;
  readonly failures: readonly SyncFailure[];
}

export const NO_COMMENTS: CommentOutcome = { region: '', comments: 0, failures: [] };

/**
 * Whether this page gets a region, given both switches (FR-9.5, FR-9.6).
 *
 * The per-page key can only ever silence one note; it cannot enable comments where
 * the subscription has them off. Read from the note on disk, which for a page being
 * created for the first time does not exist yet — and a note that does not exist has
 * not opted out of anything.
 */
function wanted(deps: CommentDeps, item: PullItem): boolean {
  if (!deps.enabled) return false;
  return !deps.vault.commentsDisabled(item.path);
}

/**
 * Fetches and renders one page's comments.
 *
 * Ordered by creation time, oldest first, so a discussion reads as a discussion:
 * `depth=all` flattens reply threads into the collection and the endpoint's own
 * order puts a reply beside its parent only by luck.
 */
export async function syncComments(deps: CommentDeps, item: PullItem): Promise<CommentOutcome> {
  if (!wanted(deps, item)) return NO_COMMENTS;

  const listed = await deps.client.listComments(item.page.id);
  if (!listed.ok) {
    deps.logger.debug(`Comments unavailable for ${item.page.title}: ${listed.error.userMessage}`);
    return {
      ...NO_COMMENTS,
      failures: [{ pageId: item.page.id, title: item.page.title, error: listed.error }],
    };
  }

  const rendered: RenderedComment[] = [...listed.value]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt,
      text: commentText(comment.storage),
      inlineRef: comment.inlineRef,
    }));

  return { region: renderCommentsRegion(rendered), comments: rendered.length, failures: [] };
}

/**
 * The `comments` hook `ExecutorDeps` asks for, bound to one subscription.
 *
 * Built here rather than at each call site for the reason `attachmentHook` is: the
 * full sync and the single-page pull have to read the same settings the same way,
 * or a region appears on one path and vanishes on the other.
 */
export function commentHook(deps: CommentDeps): (item: PullItem) => Promise<CommentOutcome> {
  return (item) => syncComments(deps, item);
}
