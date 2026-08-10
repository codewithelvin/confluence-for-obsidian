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

function serialiseNode(node: Node, options: SerialiseOptions, preserve: boolean): string {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
    case Node.CDATA_SECTION_NODE: {
      const text = node.nodeValue ?? '';
      if (preserve || !options.collapseWhitespace) return escapeText(text);
      const collapsed = text.replace(/\s+/g, ' ');
      return collapsed.trim().length === 0 ? '' : escapeText(collapsed);
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
  return Array.from(node.childNodes)
    .map((child) => serialiseNode(child, options, preserve))
    .join('');
}
