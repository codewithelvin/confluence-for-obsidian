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
   * Space of the page being compared. A same-space `ri:page` link may omit
   * `ri:space-key` in Confluence but is always written back with it, and the two
   * forms address the same page — so the implicit form is made explicit before
   * comparing. Without this, every page containing a same-space link would be
   * classed as unreproducible and become read-only.
   */
  readonly defaultSpaceKey?: string;
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

  if (options.defaultSpaceKey !== undefined) {
    applyDefaultSpaceKey(parsed.value, options.defaultSpaceKey);
  }

  return serialiseChildren(parsed.value, CANONICAL).trim();
}
