import type { PhrasingContent } from 'mdast';
import { preserveBeside } from './placeholder-factory';
import { carriedAnchor } from './placeholder-registry';
import { childrenOf } from './storage-parser';
import type { ConversionContext, PageTarget } from './types';
import { formatWikilink, isLabelSafe, isLinkable } from './wikilink';

/**
 * Recognising a Confluence page from a URL someone pasted (spec §6.4.16, D25, FR-4.23).
 *
 * FR-4.7 turns a page link into a wikilink so the mirror gains a graph and
 * backlinks — but it only ever saw an `ac:link`, the form Confluence stores when
 * the author uses the link picker. An author who **pastes a URL** gets a plain
 * `<a href>`, and those went out to the browser instead.
 *
 * They are not rare. Measured on the mirror 2026-08-13: **1 120 links on 232 notes**
 * point at a page the vault already holds — 706 raw `<a>` tags and 358 written as
 * Markdown links, plus 56 carrying a `#fragment`. Page 20840530 (`TAXAZ-260`) is
 * linked from specification after specification as prose: *"described in the Address
 * elements chapter of TAXAZ-260"*.
 *
 * Two URL shapes, both of which Confluence itself produces:
 *  - `/pages/viewpage.action?pageId=20840530` — what the page's own address bar shows;
 *  - `/display/SPACE/Page+Title` — the pretty form, and the one this converter writes
 *    for a page *outside* the mirror (`pageUrl`).
 */

/** How a URL names its page: by id, or by space and title. */
export type PageUrlTarget =
  | { readonly kind: 'id'; readonly pageId: string }
  | { readonly kind: 'title'; readonly target: PageTarget };

const PAGE_ID = /[?&]pageId=(\d+)(?:&|$)/;
const DISPLAY = /\/display\/([^/?#]+)\/([^?#]+)$/;

/**
 * Percent-decoding that returns `null` rather than throwing.
 *
 * A pasted URL is untrusted text and a stray `%` makes `decodeURIComponent` throw.
 * The mirror holds such a link — `/display/C/%5CUsers%5CMAX%5CAppData%5C…`, a Windows
 * path someone dropped into the editor — so this is a real path, not a defensive one.
 */
function decode(value: string): string | null {
  try {
    // `pageUrl` writes a space as `+`, which is what Confluence's own pretty URLs
    // use. A title holding a literal `+` arrives as `%2B`, so this order is safe.
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * The page a URL addresses, or `null` when it addresses no single page.
 *
 * A URL carrying a `#fragment` is refused. It names a *place on* a page, and a
 * wikilink to the page alone would land the reader at the top of a long document
 * instead of at the chapter the author sent them to — 56 of the mirror's 1 120. A
 * browser link that still works beats an internal one that loses the destination
 * (§16 O25 asks whether the fragment can be resolved to a heading instead).
 *
 * `spaceKey` falls back to the page being converted, matching every other link
 * resolver here: `/display/` always names its space, so the fallback is unreachable
 * from that branch and exists for the caller's convenience.
 */
export function readPageUrl(url: string, baseUrl: string): PageUrlTarget | null {
  if (baseUrl.length === 0 || !url.startsWith(baseUrl)) return null;

  const path = url.slice(baseUrl.length);
  if (path.includes('#')) return null;

  const byId = PAGE_ID.exec(path);
  if (byId?.[1] !== undefined) return { kind: 'id', pageId: byId[1] };

  const byTitle = DISPLAY.exec(path);
  const rawSpace = byTitle?.[1];
  const rawTitle = byTitle?.[2];
  if (rawSpace === undefined || rawTitle === undefined) return null;

  const spaceKey = decode(rawSpace);
  const title = decode(rawTitle);
  if (spaceKey === null || title === null || title.length === 0) return null;

  return { kind: 'title', target: { spaceKey, title } };
}

/** Which note a pasted URL points at, by whichever key it used. */
function resolve(named: PageUrlTarget, ctx: ConversionContext): string | null {
  return named.kind === 'id'
    ? (ctx.resolvePageId?.(named.pageId) ?? null)
    : (ctx.resolveTarget?.(named.target) ?? null);
}

/**
 * A pasted Confluence URL as a wikilink, or `null` when it cannot be one.
 *
 * FR-4.7's rule reaching the links Confluence stored as a URL rather than as an
 * `ac:link`, which is what an author gets for pasting one instead of using the link
 * picker. The mirror sent 1 120 of them out to a browser while the note they pointed
 * at sat in the same vault.
 *
 * The anchor's own text becomes the label, so it has to be plain: a wikilink label
 * cannot carry a nested `<span style>`, and an anchor wrapping an image is not a text
 * link at all. Either falls back to the caller's other branches, where the link still
 * works — it just leaves Obsidian.
 *
 * The element itself rides in the fragment rather than being rebuilt from the path. It
 * has to: the mirror's 816 anchors carry their attributes in five different orders,
 * and a reverse pass that picked one would fail certification on the other four.
 */
export function internalPageLink(
  element: Element,
  href: string,
  ctx: ConversionContext,
): PhrasingContent | null {
  const named = readPageUrl(href, ctx.baseUrl);
  if (named === null) return null;

  const path = resolve(named, ctx);
  if (path === null || !isLinkable(path)) return null;

  if (childrenOf(element).some((child) => child.nodeType === Node.ELEMENT_NODE)) return null;

  const text = (element.textContent ?? '').trim();
  if (text.length === 0 || !isLabelSafe(text)) return null;

  // The label is dropped where it already says the page's name, which is what the
  // final path segment is — `[[…/TAXAZ-260|TAXAZ-260]]` says it twice.
  const label = text === path.slice(path.lastIndexOf('/') + 1) ? null : text;

  const carried = preserveBeside(ctx.placeholders, element, {
    type: 'link',
    label: `link to ${text}`,
  });
  return { type: 'html', value: `${formatWikilink(path, label)}${carriedAnchor(carried)}` };
}
