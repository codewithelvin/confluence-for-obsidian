import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';
import { markdownToStorage } from './markdown-to-storage';
import { normaliseMarkdown, normaliseStorage } from './normalise';
import { storageToMarkdown, type ConversionOptions } from './storage-to-markdown';
import type { FragmentMap } from './types';

/**
 * The two fidelity checks (spec §6.4.4). Together they give the safety of a
 * read-only-when-uncertain model without making complex pages unreadable.
 *
 *  A. Certification, once per page on pull: *can this page ever be pushed
 *     safely?* A page that fails is fully readable but read-only.
 *  B. Verification, on every push: *did this edit stay within what can be
 *     represented?* A failure blocks the push.
 */

/** Describes where two strings first diverge, for diagnostics. */
export function firstDifference(left: string, right: string): string | null {
  if (left === right) return null;

  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;

  const window = 60;
  const from = Math.max(0, index - window / 2);
  return (
    `diverges at character ${String(index)}:\n` +
    `  expected: …${left.slice(from, index + window)}…\n` +
    `  actual:   …${right.slice(from, index + window)}…`
  );
}

export interface Certification {
  readonly certified: boolean;
  readonly markdown: string;
  readonly fragments: FragmentMap;
  /** Why certification failed, or `null` when it passed. */
  readonly detail: string | null;
}

/**
 * Pull-time certification: `storage -> markdown -> storage`.
 *
 * A failure marks the page `degraded`, which disables push for it. It never
 * blocks the pull — the note is still written and still readable.
 */
export function certify(
  storage: string,
  options: ConversionOptions,
): Result<Certification, AppError> {
  const forward = storageToMarkdown(storage, options);
  if (!forward.ok) return forward;

  const back = markdownToStorage(forward.value.markdown, forward.value.fragments, options);
  if (!back.ok) {
    return ok({
      certified: false,
      markdown: forward.value.markdown,
      fragments: forward.value.fragments,
      detail: back.error.userMessage,
    });
  }

  const canonical = { defaultSpaceKey: options.spaceKey };
  const expected = normaliseStorage(storage, canonical);
  const actual = normaliseStorage(back.value, canonical);

  return ok({
    certified: expected === actual,
    markdown: forward.value.markdown,
    fragments: forward.value.fragments,
    detail: firstDifference(expected, actual),
  });
}

export interface Verification {
  readonly verified: boolean;
  /** The body that would be sent to Confluence. Only push it when verified. */
  readonly storage: string;
  /** What the note would look like after a round trip; the basis of the diff. */
  readonly roundTripped: string;
  readonly detail: string | null;
}

/**
 * Push-time verification: `markdown -> storage -> markdown`.
 *
 * Compares against the user's own Markdown, so the diff shown on failure points
 * at the edit that cannot be represented rather than at storage-format internals.
 */
export function verify(
  markdown: string,
  fragments: FragmentMap,
  options: ConversionOptions,
): Result<Verification, AppError> {
  const storage = markdownToStorage(markdown, fragments, options);
  if (!storage.ok) return storage;

  const back = storageToMarkdown(storage.value, options);
  if (!back.ok) return back;

  const expected = normaliseMarkdown(markdown);
  const actual = normaliseMarkdown(back.value.markdown);

  return ok({
    verified: expected === actual,
    storage: storage.value,
    roundTripped: back.value.markdown,
    detail: firstDifference(expected, actual),
  });
}
