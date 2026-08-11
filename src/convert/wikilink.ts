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

/**
 * Builds `![[path]]`, or `![[path|size]]` for an image Confluence gave a size.
 */
export function formatEmbed(path: string, size: string | null): string {
  return size === null ? `![[${path}]]` : `![[${path}|${size}]]`;
}

/** An embed's size, as Obsidian spells it: a pixel width and an optional height. */
export interface EmbedSize {
  readonly width: string;
  readonly height: string | null;
}

/**
 * The embed label for an `ac:image`'s sizing, or `null` when it has none.
 *
 * Obsidian reads an embed's label as a pixel width, or as `width x height` when
 * it holds both — between them the two `ac:image` sizings that survive the trip
 * in both directions. Accepting only the first cost more than it looks: of the
 * 3 986 images the mirror preserved as placeholders, 2 651 carried a width *and*
 * a height, and every one of them was hidden behind a label despite its file
 * already sitting in the vault.
 *
 * A height on its own has no embed form. `null` here, so the caller keeps such an
 * image preserved rather than inventing a width to go with it.
 */
export function embedSize(width: string | null, height: string | null): string | null {
  if (width === null) return null;
  return height === null ? width : `${width}x${height}`;
}

/**
 * Reads an embed label back as a size, or `null` when it is not one.
 *
 * Anything else is a label this converter did not write — the user may have
 * embedded a file of their own and named it — so the reverse pass leaves it alone.
 */
export function parseEmbedSize(label: string): EmbedSize | null {
  const match = /^(\d+)(?:x(\d+))?$/.exec(label);
  const width = match?.[1];
  if (match === null || width === undefined) return null;

  return { width, height: match[2] ?? null };
}

export interface Wikilink {
  readonly path: string;
  /** Visible text, or `null` when the link shows the page's own name. */
  readonly label: string | null;
}

/**
 * A run of plain text, a wikilink, or an embed, in document order.
 *
 * Both bracket forms are recognised in one pass, because `![[x]]` contains
 * `[[x]]`: a scanner that knew only about links would match the inside of an
 * embed, turn an attached image into a page link, and leave a stray `!`.
 */
export type WikilinkSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly link: Wikilink }
  | { readonly kind: 'embed'; readonly link: Wikilink };

/**
 * Matches a wikilink, non-greedily so that two on one line stay separate.
 *
 * Deliberately not anchored: a wikilink usually sits inside a sentence, and the
 * text around it has to survive.
 */
const PATTERN = /(!?)\[\[([^[\]|#^]+)(\|([^[\]]*))?\]\]/g;

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
    const path = match[2];
    if (start === undefined || path === undefined) continue;

    if (start > index) segments.push({ kind: 'text', value: text.slice(index, start) });
    segments.push({
      kind: match[1] === '!' ? 'embed' : 'link',
      link: { path, label: match[4] ?? null },
    });
    index = start + match[0].length;
  }

  if (segments.length === 0) return [{ kind: 'text', value: text }];
  if (index < text.length) segments.push({ kind: 'text', value: text.slice(index) });
  return segments;
}
