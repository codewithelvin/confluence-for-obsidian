import type { PullPlan } from './pull-planner';
import type { PageState, SubscriptionState } from './sync-state';

/**
 * Turning a finished sync into the next index (spec §6.6.1, §6.6.2 step 7).
 *
 * Pure: it takes what the index held and what the sync actually managed to do, and
 * returns what the index should hold next. The write itself is the caller's, which
 * is what lets every ordering rule below be tested without a state file.
 */

export interface AppliedSync {
  /** Moves and renames that succeeded — a failed one must keep its old path. */
  readonly relocated: PullPlan['relocate'];
  readonly deleted: PullPlan['deleteLocal'];
  /** Records produced by pulls and conflict resolutions, in application order. */
  readonly states: readonly PageState[];
  /** Index entries for pages gone on both sides (`PullPlan.forget`). */
  readonly forget: readonly string[];
}

/**
 * The next state of one subscription.
 *
 * Order is the whole content of this function:
 *
 *  1. **relocations** patch the path and title of a record that is otherwise
 *     unchanged — a page that only moved was never fetched, so there is no new
 *     record for it and the old one must be edited rather than replaced;
 *  2. **new records** then overwrite wholesale, because a page that *was* fetched
 *     already knows its final path;
 *  3. **deletions and forgets** come last, so a page that was removed cannot be
 *     resurrected by a relocation the same sync had planned for it.
 */
export function nextSubscriptionState(
  previous: SubscriptionState,
  applied: AppliedSync,
  syncedAt: string,
): SubscriptionState {
  const pages = new Map(Object.entries(previous.pages));

  for (const item of applied.relocated) {
    const before = pages.get(item.pageId);
    if (before === undefined) continue;

    pages.set(item.pageId, {
      ...before,
      localPath: item.to,
      title: item.title,
      isFolderNote: item.isFolderNote,
    });
  }

  for (const state of applied.states) pages.set(state.pageId, state);
  for (const page of applied.deleted) pages.delete(page.pageId);
  for (const pageId of applied.forget) pages.delete(pageId);

  return { lastSyncedAt: syncedAt, pages: Object.fromEntries(pages) };
}
