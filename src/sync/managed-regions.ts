/**
 * Managed regions (spec §6.7, FR-5.8, FR-9.3).
 *
 * A managed region is plugin-generated content inside an otherwise user-owned
 * note — in v1, the read-only comments block. It is regenerated wholesale on
 * every pull (FR-9.4) and **never** pushed (FR-5.8).
 *
 * Pure string work, and deliberately a single function. The spec is explicit
 * that stripping must be the *same* step before conversion and before push
 * verification (§6.7): a mismatch there fails verification on every page that
 * has a comment, which would look like a converter bug and is not one.
 */

export const COMMENTS_BEGIN = '<!-- confluence:comments:begin -->';
export const COMMENTS_END = '<!-- confluence:comments:end -->';

/**
 * Every managed region, as `[begin, end]` sentinel pairs.
 *
 * A list rather than a constant because §6.7 leaves room for a second region,
 * and the strip has to know about all of them or the one it does not know about
 * gets pushed.
 */
const REGIONS: readonly (readonly [string, string])[] = [[COMMENTS_BEGIN, COMMENTS_END]];

/**
 * Removes every managed region from a note body.
 *
 * An **unterminated** region is stripped to the end of the file. §6.7 puts the
 * region at the end of the note, so there is nothing of the user's after it, and
 * the alternative — leaving a half-region in place — pushes a comment sentinel
 * and a colleague's remark into the page body.
 *
 * The blank line the region was separated by goes with it, so a note that had
 * comments and a note that never did produce byte-identical Markdown. Without
 * that, pulling comments would change the body hash and make every page look
 * locally modified.
 */
export function stripManagedRegions(body: string): string {
  let result = body;

  for (const [begin, end] of REGIONS) {
    for (;;) {
      const start = result.indexOf(begin);
      if (start === -1) break;

      const closing = result.indexOf(end, start + begin.length);
      const stop = closing === -1 ? result.length : closing + end.length;
      result = `${result.slice(0, start).replace(/\n+$/, '\n')}${result.slice(stop)}`;
    }
  }

  return result.replace(/\s*$/, '');
}
