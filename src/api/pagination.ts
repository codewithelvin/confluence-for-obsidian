import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import type { PagedResult } from './api-types';

/**
 * Paged collection walking (spec §6.2.2).
 *
 * Every list endpoint is consumed through here. `start`/`limit` is used rather
 * than `_links.next`, because that link is relative to the instance root and
 * already contains any reverse-proxy context path — appending it to a base URL
 * that also contains that path would duplicate it.
 */

export type FetchPage<T> = (
  start: number,
  limit: number,
) => Promise<Result<PagedResult<T>, AppError>>;

/**
 * Upper bound on a single collection walk.
 *
 * A server that ignores `start` returns a full page forever, and the loop would
 * never end. The cap turns a hang into a reported error, and sits far above any
 * real space: 20,000 pages is well past the point where a subscription should
 * have been narrowed to a subtree (decision D7).
 */
export const MAX_COLLECTED = 20_000;

export interface CollectOptions {
  /** Called after each page arrives, for progress reporting (FR-3.4). */
  readonly onProgress?: (collected: number) => void;
  /** Aborts the walk between pages, leaving the caller to discard the result. */
  readonly isCancelled?: () => boolean;
}

export async function collectAllPages<T>(
  fetchPage: FetchPage<T>,
  pageSize: number,
  options: CollectOptions = {},
): Promise<Result<T[], AppError>> {
  const collected: T[] = [];
  let start = 0;

  for (;;) {
    const page = await fetchPage(start, pageSize);
    if (!page.ok) return page;

    collected.push(...page.value.results);
    options.onProgress?.(collected.length);

    if (page.value.results.length < pageSize) return ok(collected);
    if (options.isCancelled?.() === true) return ok(collected);

    if (collected.length >= MAX_COLLECTED) {
      return err(
        new AppError(
          'UNKNOWN',
          `Confluence returned more than ${String(MAX_COLLECTED)} results without ending the ` +
            'list. Narrow the subscription to a page subtree rather than a whole space.',
        ),
      );
    }
    start += pageSize;
  }
}
