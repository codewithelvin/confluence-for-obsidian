import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';

/**
 * Parsing Confluence storage format (spec §6.4.1).
 *
 * Storage format is XHTML using the `ac:` and `ri:` namespaces, neither of which
 * is declared in the fragment the API returns, so a declaring root is wrapped
 * around it before parsing.
 *
 * XML mode is required. HTML mode silently mishandles self-closing namespaced
 * elements: `<ac:structured-macro ac:name="toc"/>` is not a void element to the
 * HTML parser, so every following sibling would be nested inside it.
 *
 * XML mode brings its own problem — storage format contains HTML named
 * entities such as `&nbsp;`, which are undefined in XML and would be a parse
 * error. They are decoded first, using the platform's own HTML parser as the
 * entity table so no hand-maintained list can drift from reality.
 */

const AC_NAMESPACE = 'http://atlassian.com/content';
const RI_NAMESPACE = 'http://atlassian.com/resource/identifier';

/** The five entities XML defines itself; these must survive untouched. */
const XML_BUILTIN_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

const entityCache = new Map<string, string | null>();

/**
 * Decodes a named HTML entity via the HTML parser. Returns `null` when the
 * name is not a real entity, in which case it is left alone so the XML parse
 * fails loudly rather than silently altering content.
 */
function decodeNamedEntity(name: string): string | null {
  const cached = entityCache.get(name);
  if (cached !== undefined) return cached;

  // Decoded in an *attribute* deliberately. In text content HTML applies a
  // legacy rule that matches the longest valid prefix, so `&notarealentity;`
  // would decode as `¬arealentity;` — silently corrupting content. In an
  // attribute value a named reference not terminated by `;` is left literal, so
  // only genuine entities decode.
  const document = new DOMParser().parseFromString(`<i data-e="&${name};"></i>`, 'text/html');
  const value = document.getElementsByTagName('i')[0]?.getAttribute('data-e') ?? '';
  const decoded = value === `&${name};` || value.length === 0 ? null : value;

  entityCache.set(name, decoded);
  return decoded;
}

/** Escapes the characters that would break XML if inserted raw. */
function escapeForXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replaces HTML named entities with their literal characters so an XML parser
 * accepts the document. Numeric references are already valid XML and are left
 * as they are.
 */
export function decodeHtmlEntities(xhtml: string): string {
  return xhtml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => {
    if (XML_BUILTIN_ENTITIES.has(name)) return match;
    const decoded = decodeNamedEntity(name);
    return decoded === null ? match : escapeForXml(decoded);
  });
}

/**
 * Parses a storage-format body into a DOM root whose children are the body's
 * top-level nodes.
 */
export function parseStorage(xhtml: string): Result<Element, AppError> {
  const prepared = decodeHtmlEntities(xhtml);
  const wrapped =
    `<storage-root xmlns:ac="${AC_NAMESPACE}" xmlns:ri="${RI_NAMESPACE}">` +
    `${prepared}</storage-root>`;

  let document: Document;
  try {
    document = new DOMParser().parseFromString(wrapped, 'application/xml');
  } catch (cause) {
    return err(unparseable(String(cause)));
  }

  const parseError = document.getElementsByTagName('parsererror')[0];
  if (parseError !== undefined) {
    return err(unparseable(parseError.textContent ?? 'unknown XML parse error'));
  }

  const root = document.documentElement;
  if (root === null || root.nodeName !== 'storage-root') {
    return err(unparseable('the storage body did not parse into a document'));
  }

  return ok(root);
}

function unparseable(detail: string): AppError {
  return new AppError(
    'MALFORMED_RESPONSE',
    'This page could not be parsed as Confluence storage format, so it was left untouched. ' +
      'Open it in Confluence and report the page if this persists.',
    { cause: detail },
  );
}

/** Tag name of an element, lower-cased and namespace-prefixed as in storage format. */
export function tagOf(element: Element): string {
  return element.nodeName.toLowerCase();
}

/** Reads an `ac:`-namespaced attribute, tolerating prefixed and non-prefixed forms. */
export function acAttr(element: Element, name: string): string | null {
  return element.getAttributeNS(AC_NAMESPACE, name) ?? element.getAttribute(`ac:${name}`);
}

/** Reads an `ri:`-namespaced attribute, tolerating prefixed and non-prefixed forms. */
export function riAttr(element: Element, name: string): string | null {
  return element.getAttributeNS(RI_NAMESPACE, name) ?? element.getAttribute(`ri:${name}`);
}

/** Child nodes as an array, for iteration and filtering. */
export function childrenOf(node: Node): readonly Node[] {
  return Array.from(node.childNodes);
}

/**
 * Whether the element or anything inside it is `ac:`- or `ri:`-namespaced.
 *
 * Namespaced markup must never be written into a note (FR-4.9): Obsidian renders
 * an unknown tag as nothing at all, so leaking one *hides* the content it was
 * supposed to preserve. Any construct that would otherwise be emitted as raw
 * HTML has to be checked against this first.
 */
export function hasNamespacedMarkup(element: Element): boolean {
  if (tagOf(element).includes(':')) return true;
  return Array.from(element.getElementsByTagName('*')).some((descendant) =>
    tagOf(descendant).includes(':'),
  );
}

/** First element child, skipping text and comments. */
export function firstElement(element: Element): Element | null {
  for (const child of childrenOf(element)) {
    if (child.nodeType === Node.ELEMENT_NODE) return child as Element;
  }
  return null;
}
