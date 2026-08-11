import { discardInvisibleMarkup } from './discard';
import { parseStorage, riAttr } from './storage-parser';
import { CANONICAL, serialiseChildren } from './storage-serialiser';

/**
 * Normalisation for fidelity comparison (spec §6.4.4).
 *
 * Both fidelity checks compare two documents that should be equivalent but are
 * unlikely to be textually identical. Normalisation removes differences that
 * carry no meaning — attribute order, insignificant whitespace, how an empty
 * element is spelled — and nothing else.
 *
 * The same function must be applied to both sides of every comparison, or the
 * checks stop meaning anything.
 */

export function normaliseMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NormaliseOptions {
  /**
   * Compare byte-faithfully: skip the §6.4.6 pass and every equivalence claim,
   * leaving only the mechanical rules (FR-4.12). Must match the flag the
   * conversion ran under, or certification stops meaning anything.
   */
  readonly strictMarkup?: boolean;
  /**
   * Space of the page being compared. A same-space `ri:page` link may omit
   * `ri:space-key` in Confluence but is always written back with it, and the two
   * forms address the same page — so the implicit form is made explicit before
   * comparing. Without this, every page containing a same-space link would be
   * classed as unreproducible and become read-only.
   */
  readonly defaultSpaceKey?: string;
}

/**
 * Elements whose sole child paragraph carries no meaning of its own.
 *
 * Confluence writes both `<td><p>x</p></td>` and `<td>x</td>`, and both
 * `<li><p>x</p></li>` and `<li>x</li>`, for identical rendered output — the
 * editor picks one depending on how the content was created. In space EP, 35
 * pages use the wrapped form and 6 the bare form, so treating them as different
 * would leave one group or the other permanently read-only whichever way the
 * converter writes them.
 */
const SOLE_PARAGRAPH_HOSTS = new Set(['td', 'th', 'li']);

/** Replaces a lone `<p>` inside a cell or list item with its contents. */
function unwrapSoleParagraphs(root: Element): void {
  for (const host of Array.from(root.querySelectorAll('td, th, li'))) {
    if (!SOLE_PARAGRAPH_HOSTS.has(host.nodeName.toLowerCase())) continue;

    const significant = Array.from(host.childNodes).filter(
      (child) =>
        !(child.nodeType === Node.TEXT_NODE && (child.nodeValue ?? '').trim().length === 0),
    );
    const only = significant.length === 1 ? significant[0] : undefined;
    if (only === undefined || only.nodeType !== Node.ELEMENT_NODE) continue;
    if ((only as Element).nodeName.toLowerCase() !== 'p') continue;

    const paragraph = only as Element;
    while (paragraph.firstChild !== null) {
      host.insertBefore(paragraph.firstChild, paragraph);
    }
    host.removeChild(paragraph);
  }
}

/**
 * Puts nested bold-and-italic into one order.
 *
 * `<strong><em>x</em></strong>` and `<em><strong>x</strong></em>` render
 * identically, and Markdown writes both as `***x***`, which re-parses into a
 * single fixed order. Comparing the two as different would make every page
 * using bold italics read-only over nesting that carries no meaning.
 */
function canonicaliseNestedEmphasis(root: Element): void {
  for (const outer of Array.from(root.querySelectorAll('em, i'))) {
    const children = Array.from(outer.childNodes);
    const inner = children.length === 1 ? children[0] : undefined;
    if (inner === undefined || inner.nodeType !== Node.ELEMENT_NODE) continue;

    const innerTag = (inner as Element).nodeName.toLowerCase();
    if (innerTag !== 'strong' && innerTag !== 'b') continue;

    const parent = outer.parentNode;
    if (parent === null) continue;

    // Swap: <em><strong>x</strong></em> becomes <strong><em>x</em></strong>.
    const strong = inner as Element;
    parent.insertBefore(strong, outer);
    parent.removeChild(outer);
    while (strong.firstChild !== null) outer.appendChild(strong.firstChild);
    strong.appendChild(outer);
  }
}

/** Makes implicit same-space page references explicit, so both forms compare equal. */
function applyDefaultSpaceKey(root: Element, spaceKey: string): void {
  for (const page of Array.from(root.getElementsByTagName('ri:page'))) {
    if (riAttr(page, 'space-key') === null) {
      page.setAttribute('ri:space-key', spaceKey);
    }
  }
}

/**
 * Canonical form of a storage-format body: parsed, then re-serialised
 * deterministically, so comparison is structural rather than textual.
 *
 * An unparseable body falls back to whitespace collapsing so a comparison still
 * happens; deciding what an unparseable page means is the caller's job.
 */
export function normaliseStorage(xhtml: string, options: NormaliseOptions = {}): string {
  const parsed = parseStorage(xhtml);
  if (!parsed.ok) {
    return xhtml.replace(/\s+/g, ' ').trim();
  }

  // The equivalence claims of §6.4.5, in the same order on both sides of every
  // comparison. Strict markup keeps only the mechanical rules below.
  if (options.strictMarkup !== true) {
    discardInvisibleMarkup(parsed.value);
    unwrapSoleParagraphs(parsed.value);
    canonicaliseNestedEmphasis(parsed.value);
  }

  if (options.defaultSpaceKey !== undefined) {
    applyDefaultSpaceKey(parsed.value, options.defaultSpaceKey);
  }

  return serialiseChildren(parsed.value, CANONICAL).trim();
}
