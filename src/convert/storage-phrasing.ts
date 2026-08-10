import type { PhrasingContent } from 'mdast';
import { makeInlinePlaceholder } from './placeholder-factory';
import { collapse, readInlinePlaceholderId } from './placeholder-registry';
import { childrenOf, riAttr, tagOf } from './storage-parser';
import type { ConversionContext } from './types';

/**
 * Inline (phrasing) conversion, storage format to mdast (spec §6.4.2).
 *
 * Anything not handled here becomes an inline placeholder. The mapping table is
 * a whitelist: unknown input is preserved, never guessed at.
 */

/**
 * Absolute URL of a Confluence page.
 *
 * The `/display/SPACE/Title` form is used rather than `viewpage.action?…`
 * because a query string forces Markdown to escape its `&` as `\&`, which is
 * correct but ugly in a note the user reads and edits.
 */
export function pageUrl(baseUrl: string, spaceKey: string, title: string): string {
  const path = encodeURIComponent(title).replace(/%20/g, '+');
  return `${baseUrl}/display/${encodeURIComponent(spaceKey)}/${path}`;
}

function textOf(element: Element): string {
  return element.textContent ?? '';
}

/** Link text for an `ac:link`: an explicit body if present, else the page title. */
function linkChildren(
  element: Element,
  fallback: string,
  ctx: ConversionContext,
): PhrasingContent[] {
  for (const child of childrenOf(element)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = tagOf(child as Element);

    if (tag === 'ac:plain-text-link-body') {
      return [{ type: 'text', value: textOf(child as Element) }];
    }
    if (tag === 'ac:link-body') {
      return ctx.convertPhrasing(childrenOf(child));
    }
  }
  return [{ type: 'text', value: fallback }];
}

/**
 * Converts `ac:link`. A page link becomes an ordinary Markdown link to an
 * absolute URL; wikilinks require knowing whether the target is mirrored, which
 * is subscription state and therefore M3 (spec FR-4.7).
 */
function convertAcLink(element: Element, ctx: ConversionContext): PhrasingContent {
  const resource = firstElement(element);
  const resourceTag = resource === null ? '' : tagOf(resource);

  if (resource !== null && resourceTag === 'ri:page') {
    const title = riAttr(resource, 'content-title') ?? '';
    const spaceKey = riAttr(resource, 'space-key') ?? ctx.spaceKey;
    return {
      type: 'link',
      url: pageUrl(ctx.baseUrl, spaceKey, title),
      title: null,
      children: linkChildren(element, title, ctx),
    };
  }

  // Users need a userkey lookup and attachments need the download path, neither
  // of which a pure converter can resolve.
  const label = resourceTag === 'ri:user' ? 'user mention' : `link (${resourceTag || 'unknown'})`;
  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'link',
    name: resourceTag,
    label,
  });
}

function wrap(
  type: 'strong' | 'emphasis' | 'delete',
  element: Element,
  ctx: ConversionContext,
): PhrasingContent {
  return { type, children: ctx.convertPhrasing(childrenOf(element)) };
}

/**
 * Inline code, unless it happens to look like a placeholder.
 *
 * Real page content can contain `{cf:cfb-0001}`. Preserving such a span keeps
 * the two apart: the reinflated fragment reproduces the original exactly,
 * instead of the reverse pass hunting for a fragment that never existed and
 * blocking the push.
 */
function convertCode(element: Element, ctx: ConversionContext): PhrasingContent {
  const value = textOf(element);
  if (readInlinePlaceholderId(value) === null) return { type: 'inlineCode', value };

  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'code',
    label: `literal text resembling a placeholder: ${collapse(value, 40)}`,
  });
}

function convertAnchor(
  element: Element,
  ctx: ConversionContext,
): PhrasingContent | PhrasingContent[] {
  const href = element.getAttribute('href');
  if (href === null) return ctx.convertPhrasing(childrenOf(element));

  return {
    type: 'link',
    url: href,
    title: element.getAttribute('title'),
    children: ctx.convertPhrasing(childrenOf(element)),
  };
}

/**
 * An unstyled span carries nothing and is unwrapped. A styled one must be
 * preserved, or its formatting would be silently dropped on push.
 */
function convertSpan(
  element: Element,
  ctx: ConversionContext,
): PhrasingContent | PhrasingContent[] {
  if (element.attributes.length === 0) return ctx.convertPhrasing(childrenOf(element));

  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'span',
    label: `styled text: ${collapse(textOf(element), 40)}`,
  });
}

export function convertPhrasingElement(
  element: Element,
  ctx: ConversionContext,
): PhrasingContent | PhrasingContent[] {
  const tag = tagOf(element);

  switch (tag) {
    case 'strong':
    case 'b':
      return wrap('strong', element, ctx);
    case 'em':
    case 'i':
      return wrap('emphasis', element, ctx);
    case 's':
    case 'del':
    case 'strike':
      return wrap('delete', element, ctx);
    case 'code':
      return convertCode(element, ctx);
    case 'br':
      return { type: 'break' };
    case 'a':
      return convertAnchor(element, ctx);
    case 'span':
      return convertSpan(element, ctx);
    case 'ac:inline-comment-marker':
      // Unwrapped so the text stays readable. The marker itself cannot be
      // reproduced, so certification will mark such a page read-only — the
      // deliberate trade of readability over editability.
      return ctx.convertPhrasing(childrenOf(element));
    case 'ac:link':
      return convertAcLink(element, ctx);
    case 'ac:image':
      // Attachments are downloaded in M4; until then the source is preserved.
      return makeInlinePlaceholder(ctx.placeholders, element, {
        type: 'image',
        label: `image: ${riAttr(firstElement(element) ?? element, 'filename') ?? 'embedded'}`,
      });
    case 'time':
      return makeInlinePlaceholder(ctx.placeholders, element, {
        type: 'date',
        label: `date: ${element.getAttribute('datetime') ?? ''}`,
      });
    default:
      return makeInlinePlaceholder(ctx.placeholders, element, {
        type: 'unsupported',
        name: tag,
        label: `${tag}: ${collapse(textOf(element), 40)}`,
      });
  }
}

function firstElement(element: Element): Element | null {
  for (const child of childrenOf(element)) {
    if (child.nodeType === Node.ELEMENT_NODE) return child as Element;
  }
  return null;
}

export function convertPhrasingNodes(
  nodes: readonly Node[],
  ctx: ConversionContext,
): PhrasingContent[] {
  const output: PhrasingContent[] = [];

  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      const value = (node.nodeValue ?? '').replace(/\s+/g, ' ');
      if (value.length > 0) output.push({ type: 'text', value });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const converted = convertPhrasingElement(node as Element, ctx);
    if (Array.isArray(converted)) output.push(...converted);
    else output.push(converted);
  }

  return output;
}
