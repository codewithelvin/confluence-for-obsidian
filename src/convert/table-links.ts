import { preserveBeside } from './placeholder-factory';
import { childrenOf, firstElement, riAttr, tagOf } from './storage-parser';
import type { ConversionContext } from './types';

/**
 * Page links inside a preserved table (spec §6.4.18, D27, FR-4.25, closes §16 O19).
 *
 * The last large category of table that §6.4.7 still refused. Censused on the mirror
 * 2026-08-13, of **290 refused tables**: ~84 are blocked by an `ri:page` link and
 * nothing else it cannot show, 26 by a cross-page anchor (§16 O25), 21 by a user
 * mention, 90 by a macro — mostly `jira` (684 occurrences) and `qron-calc-macro` (103),
 * neither of which can be drawn without the system behind it. Page links are the one
 * remaining bucket big enough to be worth a decision, and the client reported six of
 * them on a single page (91498324) before the census was finished.
 *
 * The projection is §6.4.10's `<a>` again, but pointed inward. Obsidian resolves a
 * click on `a.internal-link` through a document-wide handler that reads `data-href`, so
 * the markup its own renderer emits for a wikilink works inside a raw HTML block too —
 * which is the one thing here that needed confirming on the real thing rather than
 * reasoning, and the client tested it.
 *
 * A target **outside** the mirror becomes an absolute Confluence URL rather than a
 * stand-in name. That is FR-4.7's existing answer for a page link in prose, and it is
 * the better one: unlike a missing file, the page is really there — it is just not here.
 */

/** The class Obsidian's own renderer puts on an internal link. */
const INTERNAL_CLASS = 'internal-link';

/**
 * The visible text of a page link, as Confluence draws it.
 *
 * A bodyless link shows the page's title; a link with a body shows the body. The body's
 * *markup* is flattened to its words, which is a loss of formatting and not of content —
 * §6.4.17's judgement again, since refusing over a `<span style>` inside a link would
 * hide a whole table for a colour. Nothing is lost on the way back either: the carrier
 * restores the original element, markup and all.
 */
function linkText(element: Element, title: string): string {
  for (const child of childrenOf(element)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = tagOf(child as Element);
    if (tag !== 'ac:plain-text-link-body' && tag !== 'ac:link-body') continue;

    const text = ((child as Element).textContent ?? '').trim();
    return text.length > 0 ? text : title;
  }
  return title;
}

/**
 * The `<a>` for a page link, or `null` when it is not one this can show.
 *
 * Only `ri:page`. A user mention is left refusing the table: its display name is not in
 * the storage — `ri:userkey` is all there is — so there is nothing to draw without a
 * lookup the converter cannot make (§7.4 forbids it I/O). A cross-page anchor is O25's
 * question and keeps its own shape.
 */
function pageLinkElement(element: Element, ctx: ConversionContext): Element | null {
  const resource = firstElement(element);
  if (resource === null || tagOf(resource) !== 'ri:page') return null;

  const title = riAttr(resource, 'content-title');
  if (title === null || title.length === 0) return null;

  const spaceKey = riAttr(resource, 'space-key') ?? ctx.spaceKey;
  const text = linkText(element, title);
  if (text.length === 0) return null;

  const document = element.ownerDocument;
  const anchor = document.createElement('a');
  const path = ctx.resolveTarget?.({ spaceKey, title }) ?? null;

  if (path !== null && path.length > 0) {
    // The raw path, unencoded: Obsidian resolves `data-href` as a vault path the way it
    // resolves a wikilink's target, and percent-encoding it would stop it resolving.
    anchor.setAttribute('class', INTERNAL_CLASS);
    anchor.setAttribute('data-href', path);
    anchor.setAttribute('href', path);
  } else {
    anchor.setAttribute('href', confluenceUrl(ctx.baseUrl, spaceKey, title));
  }

  anchor.appendChild(document.createTextNode(text));
  return anchor;
}

/**
 * The `/display/SPACE/Title` address of a page, for a target the vault does not hold.
 *
 * The same form `pageUrl` writes for a page link in prose, spelled here rather than
 * imported to keep this module's dependencies to the parser it already needs.
 */
function confluenceUrl(baseUrl: string, spaceKey: string, title: string): string {
  const path = encodeURIComponent(title).replace(/%20/g, '+');
  return `${baseUrl}/display/${encodeURIComponent(spaceKey)}/${path}`;
}

/**
 * Replaces every page link in a *copy* of a table with the link that shows it.
 *
 * Mutates. Returns `false` as soon as one of them cannot be shown, and the caller then
 * keeps the whole table preserved. Planned in full before anything is allocated, because
 * `preserveBeside` takes the next fragment id as a side effect — the trap §6.4.10
 * records.
 *
 * Runs **before** §6.4.10's media pass, which visits `ac:link` too and refuses any whose
 * resource is not an attachment. Reversing the order would let it refuse the table
 * before this pass ever saw the link.
 */
export function hideTablePageLinksIn(clone: Element, ctx: ConversionContext): boolean {
  const planned: { readonly link: Element; readonly shown: Element }[] = [];

  for (const link of Array.from(clone.getElementsByTagName('ac:link'))) {
    const resource = firstElement(link);
    // Not a page link at all — left for the passes that do understand it, or for the
    // refusal that follows. Only a *page* link this cannot show refuses here.
    if (resource === null || tagOf(resource) !== 'ri:page') continue;
    if (link.parentNode === null) return false;

    const shown = pageLinkElement(link, ctx);
    if (shown === null) return false;

    planned.push({ link, shown });
  }

  const document = clone.ownerDocument;
  for (const { link, shown } of planned) {
    const id = preserveBeside(ctx.placeholders, link, {
      type: 'link',
      label: 'shown inside a preserved table',
    });

    const parent = link.parentNode as Node;
    parent.insertBefore(shown, link);
    parent.insertBefore(document.createComment(`cf-tbl:${id}`), link);
    parent.removeChild(link);
  }
  return true;
}
