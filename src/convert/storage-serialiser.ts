/**
 * Storage-format serialisation.
 *
 * Two callers need the same DOM walk with different settings:
 *  - fragment capture wants a faithful copy, since it will be re-injected into
 *    Confluence verbatim on push;
 *  - normalisation wants a canonical copy, so two equivalent documents compare
 *    equal regardless of attribute order or insignificant whitespace.
 */

/** Elements whose text content is significant and must never be collapsed. */
const WHITESPACE_PRESERVING = new Set([
  'pre',
  'code',
  'ac:plain-text-body',
  'ac:plain-text-link-body',
]);

/**
 * Server-generated identities, not content.
 *
 * Confluence stamps `ac:macro-id` onto structured macros and `ac:local-id` onto
 * tables and layouts. They are assigned by the server, are not required when
 * updating a page, and differ between any two otherwise-identical bodies.
 * Comparing them literally would fail certification for nearly every page that
 * contains a macro, so they are excluded from the canonical form.
 *
 * They are still preserved verbatim inside placeholder fragments — this affects
 * comparison only, never what is written back to Confluence.
 */
const IGNORED_FOR_COMPARISON = new Set([
  'ac:macro-id',
  'ac:local-id',
  // A format-version marker rather than content. Confluence fills it in when a
  // macro is written without it, and different instances emit it inconsistently.
  'ac:schema-version',
]);

export interface SerialiseOptions {
  /** Sort attributes by name. Canonical comparison only — never for re-injection. */
  readonly sortAttributes: boolean;
  /** Collapse runs of whitespace and drop whitespace-only text between elements. */
  readonly collapseWhitespace: boolean;
  /** Drop server-generated identity attributes. Comparison only. */
  readonly dropIdentityAttributes: boolean;
}

export const FAITHFUL: SerialiseOptions = {
  sortAttributes: false,
  collapseWhitespace: false,
  dropIdentityAttributes: false,
};

export const CANONICAL: SerialiseOptions = {
  sortAttributes: true,
  collapseWhitespace: true,
  dropIdentityAttributes: true,
};

export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

function serialiseAttributes(element: Element, options: SerialiseOptions): string {
  const attributes = Array.from(element.attributes).filter(
    (attribute) =>
      !attribute.name.startsWith('xmlns') &&
      !(options.dropIdentityAttributes && IGNORED_FOR_COMPARISON.has(attribute.name.toLowerCase())),
  );
  const names = attributes.map((attribute) => attribute.name);
  if (options.sortAttributes) names.sort();

  return names
    .map((name) => ` ${name}="${escapeAttribute(element.getAttribute(name) ?? '')}"`)
    .join('');
}

/**
 * Elements whose children are blocks, so whitespace between them is layout
 * rather than content.
 *
 * Everywhere else — inside a paragraph, cell, list item or emphasis — a run of
 * whitespace separates words and must survive, collapsed to a single space.
 * Dropping it everywhere made normalisation asymmetric: `1.` followed by a
 * `&nbsp;` in its own text node lost the space, while `1. ` in one text node
 * kept it, so two identical documents compared unequal.
 */
const BLOCK_CONTAINERS = new Set([
  'storage-root',
  'div',
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'ac:layout',
  'ac:layout-section',
  'ac:task-list',
]);

function serialiseNode(
  node: Node,
  options: SerialiseOptions,
  preserve: boolean,
  parentTag: string,
): string {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
    case Node.CDATA_SECTION_NODE: {
      const text = node.nodeValue ?? '';
      if (preserve || !options.collapseWhitespace) return escapeText(text);

      const collapsed = text.replace(/\s+/g, ' ');
      if (collapsed.trim().length > 0) return escapeText(collapsed);
      return BLOCK_CONTAINERS.has(parentTag) ? '' : escapeText(collapsed);
    }
    case Node.COMMENT_NODE:
      // Kept, so that losing a comment shows up as a real difference.
      return `<!--${node.nodeValue ?? ''}-->`;
    case Node.ELEMENT_NODE:
      return serialiseElement(node as Element, options, preserve);
    default:
      return '';
  }
}

/** Cells cannot carry edge whitespace through a Markdown table, and it is invisible. */
const TRIMS_EDGE_WHITESPACE = new Set(['td', 'th']);

export function serialiseElement(
  element: Element,
  options: SerialiseOptions,
  inheritedPreserve = false,
): string {
  const tag = element.nodeName.toLowerCase();
  const preserve = inheritedPreserve || WHITESPACE_PRESERVING.has(tag);
  const children = serialiseChildren(element, options, preserve);
  const attributes = serialiseAttributes(element, options);

  return children.length === 0
    ? `<${tag}${attributes}/>`
    : `<${tag}${attributes}>${children}</${tag}>`;
}

/**
 * The opening tag alone, for wrappers preserved as a placeholder pair.
 *
 * Preserving a wrapper whole would hide everything inside it. Confluence's
 * editor wraps ordinary prose in `<span style="color: rgb(0,0,0);">` — black
 * text marked black — so whole-element preservation would replace most of a
 * page with opaque tokens.
 */
export function serialiseStartTag(element: Element, options: SerialiseOptions): string {
  return `<${element.nodeName.toLowerCase()}${serialiseAttributes(element, options)}>`;
}

export function serialiseEndTag(element: Element): string {
  return `</${element.nodeName.toLowerCase()}>`;
}

export function serialiseChildren(node: Node, options: SerialiseOptions, preserve = false): string {
  const parentTag = node.nodeName.toLowerCase();
  const serialised = Array.from(node.childNodes)
    .map((child) => serialiseNode(child, options, preserve, parentTag))
    .join('');

  return options.collapseWhitespace && TRIMS_EDGE_WHITESPACE.has(parentTag)
    ? serialised.trim()
    : serialised;
}
