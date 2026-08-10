import type { PhrasingContent } from 'mdast';
import { makeInlineClose, makeInlineOpen, makeInlinePlaceholder } from './placeholder-factory';
import { CODE_SEPARATOR, collapse, readInlinePlaceholderId } from './placeholder-registry';
import { childrenOf, isDefaultColourSpan, riAttr, tagOf } from './storage-parser';
import { FAITHFUL, serialiseElement } from './storage-serialiser';
import type { ConversionContext } from './types';

/**
 * Inline (phrasing) conversion, storage format to mdast (spec §6.4.2).
 *
 * Anything not handled here becomes an inline placeholder. The mapping table is
 * a whitelist: unknown input is preserved, never guessed at.
 */

/**
 * Inline elements that wrap readable prose. These are preserved as a pair so
 * their contents stay visible and editable; everything else is preserved whole.
 */
const WRAPPER_TAGS = new Set(['u', 'ins', 'sub', 'sup', 'font', 'small', 'mark']);

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

/**
 * Inline formatting, unless the element cannot survive as Markdown emphasis.
 *
 * Three cases are preserved instead of converted:
 *  - attributes, e.g. `<strong style="letter-spacing: 0.0px;">`, which Markdown
 *    emphasis has nowhere to carry;
 *  - empty elements, since `****` is not emphasis at all;
 *  - whitespace-only content, since `** **` does not parse as emphasis either.
 */
function wrap(
  type: 'strong' | 'emphasis' | 'delete',
  element: Element,
  ctx: ConversionContext,
): PhrasingContent | PhrasingContent[] {
  const text = textOf(element);

  // A line break inside emphasis splits the Markdown delimiters across lines,
  // where they no longer pair up.
  const containsBreak = element.getElementsByTagName('br').length > 0;
  if (element.attributes.length > 0 || containsBreak) {
    return preserveWrapper(element, ctx, { type, label: `${tagOf(element)} with formatting` });
  }

  // Emphasis needs a word to attach to. `**` is not emphasis, `** **` is not
  // either, and `*.*` fails the flanking rules, so anything without a letter or
  // digit is preserved rather than converted.
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return makeInlinePlaceholder(ctx.placeholders, element, {
      type,
      label: `${tagOf(element)} without word content`,
    });
  }

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

  // An `<a href>` pointing at a Confluence page and an `ac:link` to the same
  // page both render as the same Markdown link, so the reverse pass could not
  // tell them apart and turned every such anchor into an `ac:link`. Preserving
  // the anchor as a pair keeps the two distinguishable while its text stays
  // readable.
  // A Markdown link carries only a destination and a title, so an anchor with
  // styling — `<a href="..." style="color: rgb(0,0,0);">` is common — must be
  // preserved. So must a link into Confluence, which would otherwise be
  // indistinguishable from an `ac:link` when converting back.
  const extraAttributes = Array.from(element.attributes).some(
    (attribute) => attribute.name !== 'href' && attribute.name !== 'title',
  );
  if (extraAttributes || href.startsWith(`${ctx.baseUrl}/display/`)) {
    return preserveWrapper(element, ctx, { type: 'link', label: 'link' });
  }

  return {
    type: 'link',
    url: href,
    title: element.getAttribute('title'),
    children: ctx.convertPhrasing(childrenOf(element)),
  };
}

/**
 * Preserves a wrapper element around content that stays readable.
 *
 * `open` is registered before the children and `close` after, so ids follow
 * document order and repeated conversion of unchanged content is identical.
 */
function preserveWrapper(
  element: Element,
  ctx: ConversionContext,
  detail: { type: string; label: string },
): PhrasingContent[] {
  const open = makeInlineOpen(ctx.placeholders, element, detail);
  const children = ctx.convertPhrasing(childrenOf(element));
  const close = makeInlineClose(ctx.placeholders, element, detail);
  return [open, ...children, close];
}

/**
 * A span that carries no formatting is unwrapped; one that does is preserved as
 * a pair, so the prose between stays readable and editable.
 *
 * Two spans carry nothing: one with no attributes, and one whose only style is
 * `color: rgb(0,0,0)` — black text marked black. Confluence's editor emits the
 * second constantly, and preserving it turned real pages into a wall of
 * placeholder tokens with the prose buried between them.
 */
function convertSpan(
  element: Element,
  ctx: ConversionContext,
): PhrasingContent | PhrasingContent[] {
  if (element.attributes.length === 0 || isDefaultColourSpan(element)) {
    return ctx.convertPhrasing(childrenOf(element));
  }

  return preserveWrapper(element, ctx, { type: 'span', label: 'styled text' });
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
      // Confluence writes `<br class="atl-forced-newline"/>`, and a Markdown
      // hard break cannot carry the class.
      return element.attributes.length === 0
        ? { type: 'break' }
        : { type: 'html', value: serialiseElement(element, FAITHFUL) };
    case 'a':
      return convertAnchor(element, ctx);
    case 'span':
      return convertSpan(element, ctx);
    case 'ac:inline-comment-marker':
      return preserveWrapper(element, ctx, { type: 'comment', label: 'inline comment' });
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
      // A wrapper preserved whole would hide the prose inside it, so wrappers
      // are preserved as a pair instead. Everything else — self-contained
      // constructs whose inner markup is not readable text — is preserved whole.
      return WRAPPER_TAGS.has(tag)
        ? preserveWrapper(element, ctx, { type: 'wrapper', label: tag })
        : makeInlinePlaceholder(ctx.placeholders, element, {
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

/**
 * Keeps adjacent code spans apart. Without this, two neighbouring placeholders
 * merge into one literal code span when the Markdown is read back.
 */
/** Node types whose Markdown delimiters merge when two of them sit side by side. */
const AMBIGUOUS_WHEN_ADJACENT = new Set(['inlineCode', 'strong', 'emphasis', 'delete']);

function separateAdjacentCode(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const output: PhrasingContent[] = [];

  for (const node of nodes) {
    const previous = output[output.length - 1];
    // `` `a``b` `` collapses into one code span, and `**a****b**` into one
    // strong. A zero-width separator keeps the delimiters apart; the reverse
    // pass removes it, so nothing reaches Confluence.
    if (
      previous !== undefined &&
      previous.type === node.type &&
      AMBIGUOUS_WHEN_ADJACENT.has(node.type)
    ) {
      output.push({ type: 'text', value: CODE_SEPARATOR });
    }
    output.push(node);
  }

  return output;
}

/**
 * A trailing break cannot be written as a Markdown hard break and read back: a
 * backslash at the end of a block is just a backslash. Raw `<br/>` round-trips
 * exactly and renders identically.
 */
function htmlTrailingBreak(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const output = [...nodes];

  // The whole trailing run, not just the last one: `<br/><br/>` at the end of a
  // list item is common, and a Markdown hard break only works when more content
  // follows it.
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (output[index]?.type !== 'break') break;
    output[index] = { type: 'html', value: '<br/>' };
  }

  return output;
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

  return separateAdjacentCode(htmlTrailingBreak(output));
}
