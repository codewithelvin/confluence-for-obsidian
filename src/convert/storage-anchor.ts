import type { PhrasingContent } from 'mdast';
import { collapse } from './placeholder-registry';
import { acAttr, childrenOf, tagOf } from './storage-parser';
import { escapeAttribute, escapeText } from './storage-serialiser';

/**
 * Anchor links — a link to a place on a page (spec §6.4.15, D24, FR-4.22).
 *
 * The single largest cause of a grey pill in the mirror: **3 561 of them on 147
 * pages**, 62% of every inline placeholder there is. Nearly all are
 * tables of contents imported from Word, where `_Toc42611092` names a bookmark, and
 * the damage is not the dead anchor — it is that `ac:link` was preserved *whole*, so
 * the words inside it went with it. A 30-entry contents page rendered as 30 grey
 * boxes in a column, and the reader could not even see what the entries were called.
 *
 * Markdown has the construct exactly: a link whose destination is a fragment.
 * `[1. Список изменений](#_Toc42611092)` shows the words, styles them as a link, and
 * resolves natively in Obsidian whenever the anchor happens to name a heading —
 * which is what the 234 anchors on this instance that are *not* Word bookmarks are,
 * spelled as the heading's own title. Nothing has to be resolved for the text to
 * come back, and that is the whole win.
 *
 * Scope is the **same-page** anchor: 2 290 of the 3 561. The other 1 262 carry an
 * `ri:content-entity` naming another page, and every one of those ids — measured,
 * all 1 262 — is a page this mirror does not hold, so there is no vault target to
 * point at and no honest wikilink to write. They stay widgets until §16 O25 settles
 * whether an absolute Confluence URL is the right thing to show instead.
 */

/** The attribute that makes an `ac:link` an anchor link. */
const ANCHOR_ATTRIBUTE = 'anchor';

/** A fragment destination, as it appears in the note. */
export function anchorUrl(name: string): string {
  return `#${name}`;
}

/**
 * The anchor a fragment destination names, or `null` when the URL is not one.
 *
 * Reserved for anchor links: `convertAnchor` preserves a raw `<a href="#…">` as its
 * own tags rather than converting it, precisely so that a `#` destination in the
 * note means one thing only. Without that the reverse pass could not tell which of
 * the two to write, and every page holding either would go read-only.
 */
export function readAnchorUrl(url: string): string | null {
  if (!url.startsWith('#') || url.length === 1) return null;
  return url.slice(1);
}

/** Whether a URL addresses a place on the page it is written on. */
export function isAnchorUrl(url: string): boolean {
  return readAnchorUrl(url) !== null;
}

function firstChildElement(element: Element, tag: string): Element | null {
  for (const child of childrenOf(element)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (tagOf(child as Element) === tag) return child as Element;
  }
  return null;
}

function hasChildElement(element: Element, tag: string): boolean {
  return firstChildElement(element, tag) !== null;
}

/**
 * The anchor link's visible text, or `null` when it cannot be written as one.
 *
 * A bodyless anchor link renders as the anchor's own name — Confluence has nothing
 * else to draw — so that is the text, and the reverse pass writes a bodyless link
 * back for exactly that case. The two must agree or the page cannot round-trip.
 *
 * `ac:link-body` is refused here rather than read: it may hold real markup, and a
 * Markdown link's text cannot carry a `<span style>` and come back the same. The 22
 * links in the mirror that do stay widgets; the 2 126 whose body is nothing but text
 * never reach this point, because §6.4.5 has already rewritten them into the
 * plain-text form that renders identically.
 */
function anchorText(element: Element, name: string): string | null {
  if (hasChildElement(element, 'ac:link-body')) return null;

  const body = firstChildElement(element, 'ac:plain-text-link-body');
  return body === null ? name : (body.textContent ?? '');
}

/**
 * An anchor link as a Markdown link, or `null` when it has to stay a widget.
 *
 * Refused for anything this shape cannot carry back exactly: another page's anchor,
 * a second attribute, a rich body, or an empty text — `[](#x)` is a link with
 * nothing to click.
 */
export function convertAnchorLink(element: Element): PhrasingContent | null {
  const name = acAttr(element, ANCHOR_ATTRIBUTE);
  if (name === null || name.length === 0) return null;

  // One attribute and no `ri:` resource: anything else is a link this form does not
  // describe, and inventing a fragment for it would lose whatever it did say.
  if (element.attributes.length !== 1) return null;
  if (hasChildElement(element, 'ri:content-entity')) return null;

  const text = anchorText(element, name);
  if (text === null || text.trim().length === 0) return null;

  return {
    type: 'link',
    url: anchorUrl(name),
    title: null,
    children: [{ type: 'text', value: text }],
  };
}

/** Whether the element is an anchor link at all — asked before any conversion. */
export function isAnchorLink(element: Element): boolean {
  return acAttr(element, ANCHOR_ATTRIBUTE) !== null;
}

/**
 * What the widget says for an anchor link that has to stay one (spec FR-4.14).
 *
 * The shared label read the *resource tag*, so all 3 561 of these announced
 * themselves as `link (ac:link-body)` or `link (ri:content-entity)` — which names an
 * XML element and tells a reader nothing whatever. The link's own words are the only
 * thing that identifies it, and for the 1 262 pointing off the page, saying so is
 * the difference between a broken widget and an explained one.
 */
export function anchorLabel(element: Element): string {
  const name = acAttr(element, ANCHOR_ATTRIBUTE) ?? '';
  const text = (element.textContent ?? '').trim();
  const shown = collapse(text.length > 0 ? text : name, 80);

  return hasChildElement(element, 'ri:content-entity')
    ? `link to “${shown}” on another page`
    : `anchor link — ${shown}`;
}

/**
 * The storage form of an anchor link, for the trip back to Confluence.
 *
 * Text equal to the anchor's name is how a bodyless link renders, so it must
 * convert back to a bodyless one — the same rule `plainPageLink` follows for a page
 * link whose text is the page's title, and for the same reason.
 *
 * The text is escaped rather than wrapped in CDATA, which is the opposite of what
 * `plainPageLink` does. Both forms are valid and normalisation reads them alike, so
 * either would keep the page certified — but Confluence stores these as plain text,
 * and matching it means a push that changed nothing leaves the stored XML
 * byte-identical instead of rewriting 3 000 link bodies into a form nobody asked for.
 */
export function anchorLinkStorage(name: string, text: string): string {
  const attribute = `ac:anchor="${escapeAttribute(name)}"`;
  if (text === name) return `<ac:link ${attribute}/>`;

  return (
    `<ac:link ${attribute}>` +
    `<ac:plain-text-link-body>${escapeText(text)}</ac:plain-text-link-body></ac:link>`
  );
}
