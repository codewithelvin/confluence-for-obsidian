/**
 * Obsidian wikilink syntax (spec FR-4.7).
 *
 * One module for both directions, because the two have to agree exactly: a
 * wikilink the forward pass writes and the reverse pass cannot read again turns
 * every page containing an internal link read-only.
 *
 * Pure string work. Whether a target *is* mirrored is a question about the vault,
 * which the converter cannot answer — it asks through `ConversionOptions`.
 */

/**
 * Characters that would make a wikilink ambiguous.
 *
 * `|` separates the label, `#` addresses a heading, and `[`/`]` end the link.
 * Confluence titles may legally contain all four, and a page whose path does is
 * linked with ordinary Markdown instead — a working link beats a wikilink that
 * resolves to nothing.
 */
const UNSAFE = /[[\]|#^]/;

export function isLinkable(path: string): boolean {
  return path.length > 0 && !UNSAFE.test(path);
}

/**
 * Builds `[[path]]`, or `[[path|label]]` when the visible text differs from the
 * page's own title.
 */
export function formatWikilink(path: string, label: string | null): string {
  return label === null ? `[[${path}]]` : `[[${path}|${label}]]`;
}

export interface Wikilink {
  readonly path: string;
  /** Visible text, or `null` when the link shows the page's own name. */
  readonly label: string | null;
}

/** A run of plain text, or a wikilink, in document order. */
export type WikilinkSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly link: Wikilink };

/**
 * Matches a wikilink, non-greedily so that two on one line stay separate.
 *
 * Deliberately not anchored: a wikilink usually sits inside a sentence, and the
 * text around it has to survive.
 */
const PATTERN = /\[\[([^[\]|#^]+)(\|([^[\]]*))?\]\]/g;

/**
 * Splits text into plain runs and wikilinks.
 *
 * Text with no wikilink in it comes back as a single `text` segment, which is the
 * overwhelming majority of calls.
 */
export function splitWikilinks(text: string): readonly WikilinkSegment[] {
  const segments: WikilinkSegment[] = [];
  let index = 0;

  for (const match of text.matchAll(PATTERN)) {
    const start = match.index;
    const path = match[1];
    if (start === undefined || path === undefined) continue;

    if (start > index) segments.push({ kind: 'text', value: text.slice(index, start) });
    segments.push({ kind: 'link', link: { path, label: match[3] ?? null } });
    index = start + match[0].length;
  }

  if (segments.length === 0) return [{ kind: 'text', value: text }];
  if (index < text.length) segments.push({ kind: 'text', value: text.slice(index) });
  return segments;
}
