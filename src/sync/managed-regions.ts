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
 * One comment, reduced to what the region shows.
 *
 * Text as lines rather than as one string: the region quotes every line, and
 * joining them here only to split them again is where a `>` goes missing.
 */
export interface RenderedComment {
  readonly author: string;
  /** ISO-8601, or `''` when the instance reported none. */
  readonly createdAt: string;
  readonly text: readonly string[];
  /** The inline anchor this remark is attached to, or `null` for a footer comment. */
  readonly inlineRef: string | null;
}

/**
 * Timestamp as `YYYY-MM-DD HH:MM` (§6.7's form), or the raw value if it is not one.
 *
 * Sliced rather than parsed as a date: `new Date(...)` would render in the
 * reader's own zone, so the same page pulled on two machines would produce two
 * different notes and each would look locally modified to the other.
 */
function timestamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match === null ? iso : `${match[1] ?? ''} ${match[2] ?? ''}`;
}

/**
 * Builds the comments region (spec §6.7, FR-9.3).
 *
 * A collapsed callout, so a page with forty comments does not bury the page. The
 * header says the region is regenerated, which is FR-9.4's requirement that
 * discarding local edits inside it be documented where the user meets it — a note
 * on a settings screen is not where somebody types into a quote block.
 *
 * Returns `''` for no comments at all. An empty region would be a permanent
 * artefact on the great majority of pages, and its presence or absence would
 * change the note's hash for a page nobody has commented on.
 */
export function renderCommentsRegion(comments: readonly RenderedComment[]): string {
  if (comments.length === 0) return '';

  const lines = [
    COMMENTS_BEGIN,
    `> [!quote]- Comments (${String(comments.length)}) — pulled from Confluence, replaced on every sync`,
  ];

  for (const [index, comment] of comments.entries()) {
    if (index > 0) lines.push('>');

    const when = timestamp(comment.createdAt);
    const anchor = comment.inlineRef === null ? '' : ` *(on ${comment.inlineRef})*`;
    lines.push(`> **${comment.author}**${when.length === 0 ? '' : ` — ${when}`}${anchor}`);

    // A comment whose body held nothing this region can show — an image, a macro —
    // still gets its attribution line: the reader needs to know somebody said
    // something here, and a silent omission reads as no comment at all.
    for (const line of comment.text.length === 0 ? ['*(no text)*'] : comment.text) {
      lines.push(`> ${line}`);
    }
  }

  lines.push(COMMENTS_END);
  return lines.join('\n');
}

/**
 * Appends a managed region to a converted body.
 *
 * Separated by a blank line, and `stripManagedRegions` takes that line with it, so
 * a note with comments and the same note without produce the same pushable body
 * (§6.7).
 */
export function withManagedRegions(body: string, region: string): string {
  if (region.length === 0) return body;
  return `${body.replace(/\s*$/, '')}\n\n${region}`;
}

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
