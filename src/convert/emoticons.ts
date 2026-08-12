import { acAttr } from './storage-parser';

/**
 * Emoticons (spec §6.4.9, decision D18, FR-4.15).
 *
 * `<ac:emoticon ac:name="tick"/>` is a sprite in Confluence and **nothing** in
 * Obsidian, so FR-4.9 refused it a note body and it became a placeholder. That is
 * the right answer for a macro and the wrong one here, because Unicode already has
 * the character. The construct was never inexpressible — it was never mapped.
 *
 * The cost of leaving it unmapped was not the pill but the *tables the pill took
 * down with it*: `tableAsHtml` refuses any namespaced markup, so 20 tables in the
 * EP mirror — a 23-row data dictionary among them — were hidden behind a handful
 * of stars, on top of 45 emoticons showing as pills in ordinary prose.
 *
 * The round trip is a closed bijection: every one of the 151 emoticons measured in
 * the mirror carries exactly one attribute, `ac:name`, so the name *is* the state
 * and the carrier needs no fragment id and no side table.
 */

/**
 * Confluence's emoticon names, mapped to the character that carries the same
 * meaning.
 *
 * A **whitelist**, and deliberately not a complete one. An unmapped name keeps its
 * placeholder, because a wrong character in a specification page is worse than an
 * honest pill — `light-off` is left out for exactly that reason, having no Unicode
 * equivalent that reads as a dimmed bulb.
 *
 * The glyph carries Confluence's *meaning*, not its pixels: Obsidian draws these
 * in the note font, so they are recognisable rather than identical. That is D18's
 * accepted cost, taken against not seeing the table at all.
 */
const GLYPHS: ReadonlyMap<string, string> = new Map([
  ['tick', '✅'],
  ['cross', '❌'],
  ['warning', '⚠️'],
  ['information', 'ℹ️'],
  ['question', '❓'],
  ['plus', '➕'],
  ['minus', '➖'],
  ['light-on', '💡'],
  ['yellow-star', '⭐'],
  ['thumbs-up', '👍'],
  ['thumbs-down', '👎'],
  ['smile', '🙂'],
  ['sad', '🙁'],
  ['laugh', '😄'],
  ['wink', '😉'],
  ['cheeky', '😛'],
]);

const EMOTICON_TAG = 'ac:emoticon';

/** The character for an emoticon name, or `null` when it is not in the mapping. */
export function emoticonGlyph(name: string): string | null {
  return GLYPHS.get(name) ?? null;
}

/**
 * The note form of an emoticon: the character, then an invisible carrier naming it.
 *
 * The marker **follows** the character for the reason §6.4.8 gives — a line
 * *starting* with `<!--` is a CommonMark HTML block and would swallow the rest of
 * the line. Inside a preserved table the pair sits in raw HTML, where an HTML
 * comment is invisible in both Obsidian modes; the same property `<!--cf-th-->`
 * already relies on.
 */
export function emoticonMarkup(name: string): string | null {
  const glyph = emoticonGlyph(name);
  return glyph === null ? null : `${glyph}${emoticonCarrier(name)}`;
}

export function emoticonCarrier(name: string): string {
  return `<!--cf-emo:${name}-->`;
}

const CARRIER_PATTERN = /^<!--cf-emo:([a-z-]+)-->$/;

/** The emoticon name behind a carrier, or `null` for ordinary HTML. */
export function readEmoticonName(html: string): string | null {
  const name = CARRIER_PATTERN.exec(html.trim())?.[1];
  return name !== undefined && GLYPHS.has(name) ? name : null;
}

/** The storage element for a name. Self-closing, as Confluence writes it. */
export function emoticonElement(name: string): string {
  return `<${EMOTICON_TAG} ac:name="${name}"/>`;
}

/**
 * Replaces every emoticon in a *copy* of a table with its character and carrier,
 * so the table stops counting as namespaced markup and can be written out as HTML.
 *
 * Mutates. Returns `false` when one of them cannot be carried — an unmapped name,
 * or an element holding more than `ac:name` — and the caller then keeps the whole
 * table preserved, with the original still intact to serialise into a fragment.
 * Refusing the table over one emoticon is deliberate: a table half-translated
 * would show a gap exactly where FR-4.9 says it must not.
 */
export function hideEmoticonsIn(clone: Element): boolean {
  const document = clone.ownerDocument;

  for (const emoticon of Array.from(clone.getElementsByTagName(EMOTICON_TAG))) {
    const name = acAttr(emoticon, 'name');
    const parent = emoticon.parentNode;
    if (parent === null || name === null || emoticon.attributes.length !== 1) return false;

    const glyph = emoticonGlyph(name);
    if (glyph === null) return false;

    parent.insertBefore(document.createTextNode(glyph), emoticon);
    parent.insertBefore(document.createComment(`cf-emo:${name}`), emoticon);
    parent.removeChild(emoticon);
  }
  return true;
}

const CARRIER_PREFIX = '<!--cf-emo:';

/**
 * Puts the emoticons back, on the way to Confluence — the exact inverse of
 * `hideEmoticonsIn`, and it has to stay exact: a table that came back without them
 * would no longer reproduce, and certification would take the push away from it.
 *
 * Matched **per name** rather than by a pattern with `(.)` in front of the carrier,
 * because a glyph is not always one code point: `⚠️` is U+26A0 U+FE0F, so a
 * single-character capture would take the variation selector and leave the warning
 * sign behind in the page.
 *
 * A carrier whose glyph the user deleted still restores the emoticon, so an edit
 * that only looked like a deletion does not silently drop content — the same
 * reasoning §6.4.8 applies to a deleted diagram embed.
 */
export function restoreEmoticons(html: string): string {
  if (!html.includes(CARRIER_PREFIX)) return html;

  let output = html;
  for (const [name, glyph] of GLYPHS) {
    const carrier = emoticonCarrier(name);
    const element = emoticonElement(name);
    output = output.split(`${glyph}${carrier}`).join(element);
    output = output.split(carrier).join(element);
  }
  return output;
}
