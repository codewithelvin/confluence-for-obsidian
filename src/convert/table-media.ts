import { preserveBeside } from './placeholder-factory';
import { childrenOf, firstElement, riAttr, tagOf } from './storage-parser';
import { PROJECTED_TASK_LIST } from './table-tasks';
import type { ConversionContext, ReverseContext } from './types';

/**
 * Pictures and file links inside a preserved table (spec §6.4.10, decision D19,
 * FR-4.16, FR-4.17).
 *
 * §6.4.7 writes a table GFM cannot express into the note as the HTML it already
 * is, then refuses the whole thing if any `ac:`/`ri:` markup is left inside —
 * because Obsidian renders such a tag as nothing, and an empty cell is worse than
 * an honest placeholder. That refusal was hiding far more than the images causing
 * it: **260 tables on 148 pages** were opaque with `ac:image` as their *only*
 * obstacle, one of them a 23-row specification hidden behind a 32-pixel
 * screenshot of a button.
 *
 * The reason it stayed unsolved is that a preserved table is a **raw HTML block**,
 * and CommonMark keeps an HTML block's content raw — so `![[…]]`, the only image
 * form the plugin emitted anywhere, is guaranteed to render there as literal text.
 * Only a real `<img src>` could work, and there was no evidence Obsidian resolved
 * one. The O18 probe settled it on 2026-08-12: it does, in Reading View and Live
 * Preview alike, and an `<a href>` follows too.
 *
 * So inside the projection an image becomes an `<img>` and a bodyless attachment
 * link becomes an `<a>`, each followed by the carrier that puts the original
 * element back on push. Everything else — a macro, a page link, a user mention, a
 * task list — still refuses the table, and still for the right reason.
 */

/** The carrier's prefix, as it appears in the note. */
const CARRIER_PREFIX = '<!--cf-tbl:';

/**
 * Marks the element in front of it as a projection of a preserved one.
 *
 * A marker of its own rather than a second meaning for `cf-img`, for the reason
 * §6.4.8 gives about `cf-drawio`: a marker names *a position*, and this position
 * is not the one `cf-img` names. `cf-img` follows an embed inside a text run and
 * is read by scanning that run; this one follows an HTML element inside an HTML
 * block, is read by a string pass over the block, and stands for an image or a
 * link indifferently — what it says is "put fragment ID back where I am".
 *
 * It **follows** its element for the reason every other carrier does: a line
 * starting with `<!--` is a CommonMark HTML block and would swallow the rest of
 * the line.
 */
export function carriedTableElement(id: string): string {
  return `${CARRIER_PREFIX}${id}-->`;
}

/**
 * A vault path as a URL an HTML attribute can hold.
 *
 * Encoded per segment, so the separators survive: `encodeURI` leaves `#`, `?` and
 * `&` alone, and a file named `Q&A #2.png` would then truncate at the `#` and show
 * nothing. The probe confirmed the percent-encoded form renders; it is also the
 * only form that survives §6.6.3 relocating the note, being anchored at the vault
 * root rather than at the note.
 */
export function attachmentUrl(vaultPath: string): string {
  return vaultPath.split('/').map(encodeURIComponent).join('/');
}

/** Schemes §7.4 allows to become a URL the reader's client will fetch. */
const SAFE_SCHEME = /^https?:\/\//i;

function setIfPresent(element: Element, name: string, value: string | null): void {
  if (value !== null) element.setAttribute(name, value);
}

/**
 * The `<img>` for an `<ac:image>`, or `null` when it cannot honestly be shown.
 *
 * `ac:width` and `ac:height` map straight across, which makes this *more* faithful
 * than the prose embed: FR-8.2 has to show a lone `ac:height` as a width, because
 * Obsidian's embed syntax sizes by width and has nowhere else to put it. HTML has
 * both attributes, so nothing is approximated here.
 *
 * Everything else the element carries — `ac:thumbnail`, a border, an alignment —
 * is presentational and simply is not drawn. None of it is lost: the original
 * rides in the fragment, and push hands Confluence back the element it gave us.
 */
function imageElement(element: Element, ctx: ConversionContext): Element | null {
  const resource = firstElement(element);
  if (resource === null) return null;

  const source = imageSource(resource, ctx);
  if (source === null) return null;

  const image = element.ownerDocument.createElement('img');
  image.setAttribute('src', source);
  setIfPresent(image, 'width', element.getAttribute('ac:width'));
  setIfPresent(image, 'height', element.getAttribute('ac:height'));
  setIfPresent(image, 'alt', element.getAttribute('ac:alt'));
  return image;
}

/**
 * Where the picture comes from: a file in the vault, or a URL §7.4 permits.
 *
 * An attachment must be **on disk** (FR-4.17) — the same condition FR-8.2 puts on
 * an embed, and not a rare one: an `ri:attachment` reference outlives the
 * attachment it names, and page 146743218 carries two links to files Confluence no
 * longer lists. A missing file refuses the whole table rather than putting a
 * broken picture inside it.
 *
 * An `<ri:url>` image keeps the scheme allowlist `convertExternalImage` applies to
 * the prose form. It matters more here: there the URL passes through a Markdown
 * parser on the way out, and here it goes into raw HTML that nothing else checks.
 */
function imageSource(resource: Element, ctx: ConversionContext): string | null {
  if (tagOf(resource) === 'ri:url') {
    const url = riAttr(resource, 'value');
    return url !== null && SAFE_SCHEME.test(url) ? url : null;
  }

  if (tagOf(resource) !== 'ri:attachment') return null;

  const path = attachmentPathOf(resource, ctx);
  return path === null ? null : attachmentUrl(path);
}

function attachmentPathOf(resource: Element, ctx: ConversionContext): string | null {
  const filename = riAttr(resource, 'filename');
  if (filename === null) return null;

  const path = ctx.resolveAttachment?.(filename) ?? null;
  return path === null || path.length === 0 ? null : path;
}

/**
 * The `<a>` for a link to an attachment, or `null` when it cannot be shown.
 *
 * Only a **bodyless** link qualifies: `<ac:link><ri:attachment ri:filename="X"/></ac:link>`
 * carries no text at all, so Confluence draws the file name and this can do the
 * same. A link carrying an `ac:plain-text-link-body` is refused — its text would
 * have to come back through CDATA escaping rather than attribute escaping, and
 * there are 9 such links in the whole mirror against 33 bodyless ones. Not worth
 * a second escaping path in the same change.
 */
function linkElement(element: Element, ctx: ConversionContext): Element | null {
  if (element.attributes.length > 0) return null;

  const children = childrenOf(element).filter((node) => node.nodeType === Node.ELEMENT_NODE);
  if (children.length !== 1) return null;

  const resource = children[0] as Element;
  if (tagOf(resource) !== 'ri:attachment') return null;

  const filename = riAttr(resource, 'filename');
  const path = attachmentPathOf(resource, ctx);
  if (filename === null || path === null) return null;

  const anchor = element.ownerDocument.createElement('a');
  anchor.setAttribute('href', attachmentUrl(path));
  anchor.appendChild(element.ownerDocument.createTextNode(filename));
  return anchor;
}

const IMAGE_TAG = 'ac:image';
const LINK_TAG = 'ac:link';

/**
 * Replaces every image and attachment link in a *copy* of a table with the element
 * that shows it, so the table stops counting as namespaced markup.
 *
 * Mutates. Returns `false` as soon as one of them cannot be shown, and the caller
 * then keeps the whole table preserved, with the original intact to serialise into
 * a fragment. All-or-nothing deliberately, for the reason `hideEmoticonsIn` is:
 * a table half-translated would show a gap exactly where FR-4.9 says it must not.
 */
export function hideTableMediaIn(clone: Element, ctx: ConversionContext): boolean {
  const planned = planReplacements(clone, ctx);
  if (planned === null) return false;

  const document = clone.ownerDocument;
  for (const { element, shown, type } of planned) {
    // The fragment holds the element itself rather than its attributes decoded
    // into the carrier: `ac:image` attribute sets vary — thumbnail, border,
    // alignment, alt — and the push has to hand back exactly what it was given.
    const id = preserveBeside(ctx.placeholders, element, {
      type,
      label: 'shown inside a preserved table',
    });

    const parent = element.parentNode as Node;
    parent.insertBefore(shown, element);
    parent.insertBefore(document.createComment(`cf-tbl:${id}`), element);
    parent.removeChild(element);
  }
  return true;
}

interface Replacement {
  readonly element: Element;
  readonly shown: Element;
  readonly type: string;
}

/**
 * Every replacement the table needs, or `null` if any one of them is impossible.
 *
 * Planned in full before anything is allocated, because `preserveBeside` has a
 * side effect: it takes the next fragment id. Allocating as we went would leave a
 * refused table's half-finished work in the fragment cache and push every later
 * placeholder on the page up a number — deterministic, but so is being wrong the
 * same way every time.
 *
 * Walked in **document order** across both tags rather than one tag then the
 * other, so the ids read down the table the way §6.4.3 says placeholder ids read
 * down a page.
 */
function planReplacements(clone: Element, ctx: ConversionContext): Replacement[] | null {
  const planned: Replacement[] = [];

  for (const element of Array.from(clone.getElementsByTagName('*'))) {
    const tag = tagOf(element);
    if (tag !== IMAGE_TAG && tag !== LINK_TAG) continue;
    if (element.parentNode === null) return null;

    const shown = tag === IMAGE_TAG ? imageElement(element, ctx) : linkElement(element, ctx);
    if (shown === null) return null;

    planned.push({ element, shown, type: tag === IMAGE_TAG ? 'image' : 'link' });
  }
  return planned;
}

/**
 * The pattern the reverse pass matches: an element this module wrote, followed by
 * its carrier — or the carrier alone.
 *
 * Alone matters. A carrier whose element the user deleted still restores the
 * original, so an edit that only looked like a deletion does not silently drop
 * content from the page — the same reasoning §6.4.8 applies to a deleted diagram
 * embed and §6.4.9 to a deleted glyph.
 *
 * The anchor's body is `[^<]*` rather than `.*?` because it is always a file name,
 * which the serialiser escaped on the way in; a dot-matching form could span two
 * links and take the cell between them with it.
 *
 * The task list §6.4.14 projects joins the same alternation rather than taking a
 * carrier of its own: `cf-tbl` names *a position* — "put fragment ID back where I
 * am" — and has never cared what kind of element stands there.
 */
const PROJECTED = new RegExp(
  `(?:<img\\b[^>]*\\/?>|<a\\b[^>]*>[^<]*<\\/a>|${PROJECTED_TASK_LIST})?<!--cf-tbl:(cfb-\\d+)-->`,
);

/**
 * Puts the images and links back, on the way to Confluence — the exact inverse of
 * `hideTableMediaIn`, and it has to stay exact: a table that came back without
 * them would no longer reproduce, and certification would take the push away from
 * the page.
 */
export function restoreTableMedia(html: string, ctx: ReverseContext): string {
  if (!html.includes(CARRIER_PREFIX)) return html;

  // A fresh regex per call: `lastIndex` on a shared global pattern would make the
  // result depend on who converted last.
  return html.replace(new RegExp(PROJECTED.source, 'g'), (_match, id: string) => {
    const fragment = ctx.fragments.get(id);
    if (fragment === undefined) {
      ctx.missingFragments.add(id);
      return '';
    }
    return fragment.xhtml;
  });
}
