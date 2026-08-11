import type { PhrasingContent } from 'mdast';
import { makeInlineClose, makeInlineOpen, makeInlinePlaceholder } from './placeholder-factory';
import { CODE_SEPARATOR, collapse, readInlinePlaceholderId } from './placeholder-registry';
import { acAttr, childrenOf, riAttr, tagOf } from './storage-parser';
import {
  FAITHFUL,
  serialiseElement,
  serialiseEndTag,
  serialiseStartTag,
} from './storage-serialiser';
import type { ConversionContext, PageTarget } from './types';
import { formatEmbed, formatWikilink, isLinkable } from './wikilink';

/**
 * Inline (phrasing) conversion, storage format to mdast (spec §6.4.2).
 *
 * Anything not handled here becomes an inline placeholder. The mapping table is
 * a whitelist: unknown input is preserved, never guessed at.
 */

/**
 * Inline HTML elements that wrap readable prose and that Obsidian renders
 * natively. They are written out as themselves, so `<u>`, `<sub>` and `<sup>`
 * read as underline, subscript and superscript rather than as opaque tokens.
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
 * The visible text of a page link, for a wikilink label.
 *
 * `null` means the link shows the page's own title, which is what a bodyless
 * `ac:link` renders and therefore needs no label. `undefined` means the body
 * carries markup a wikilink label cannot hold, so the caller must fall back to an
 * ordinary Markdown link — where `ac:link-body` still round-trips.
 */
function plainLabel(element: Element, title: string): string | null | undefined {
  for (const child of childrenOf(element)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = tagOf(child as Element);

    if (tag === 'ac:plain-text-link-body') {
      const text = textOf(child as Element);
      // Matching the title is how a bodyless link renders, and the reverse pass
      // writes a bodyless link for exactly that case — so the two must agree.
      return text === title ? null : text;
    }
    if (tag === 'ac:link-body') return undefined;
  }
  return null;
}

/** A label may not contain the characters that delimit a wikilink. */
function isLabelSafe(label: string): boolean {
  return !/[[\]|\n]/.test(label);
}

/**
 * A page link as an Obsidian wikilink, or `null` when it cannot be one.
 *
 * Emitted as an `html` node so `remark-stringify` writes the brackets literally
 * rather than escaping them into `\[\[`.
 */
function wikilink(
  element: Element,
  target: PageTarget,
  ctx: ConversionContext,
): PhrasingContent | null {
  const path = ctx.resolveTarget?.(target) ?? null;
  if (path === null || !isLinkable(path)) return null;

  const label = plainLabel(element, target.title);
  if (label === undefined) return null;
  if (label !== null && !isLabelSafe(label)) return null;

  return { type: 'html', value: formatWikilink(path, label) };
}

/**
 * An attached image as an Obsidian embed (spec FR-8.2), or a placeholder.
 *
 * Converted only when the whole construct can be reproduced from the embed
 * alone: a bare `<ac:image>`, or one carrying nothing but `ac:width`, wrapping a
 * `<ri:attachment>` that carries nothing but its file name. `ac:thumbnail`,
 * alignment, borders and captions have no embed form, and guessing at one would
 * make the page read-only for the sake of a picture that renders slightly wrong.
 *
 * An attachment that is not on disk stays a placeholder: a broken image is worse
 * than an honest label saying what is preserved.
 */
function convertImage(element: Element, ctx: ConversionContext): PhrasingContent {
  const resource = firstElement(element);
  const filename = resource === null ? null : riAttr(resource, 'filename');
  const width = element.getAttribute('ac:width');

  const reproducible =
    resource !== null &&
    tagOf(resource) === 'ri:attachment' &&
    resource.attributes.length === 1 &&
    element.attributes.length === (width === null ? 0 : 1);

  const path = filename === null ? null : (ctx.resolveAttachment?.(filename) ?? null);
  if (reproducible && filename !== null && path !== null && isLinkable(path)) {
    return { type: 'html', value: formatEmbed(path, width) };
  }

  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'image',
    label: `image: ${filename ?? 'embedded'}`,
  });
}

function convertAcLink(element: Element, ctx: ConversionContext): PhrasingContent {
  const resource = firstElement(element);
  const resourceTag = resource === null ? '' : tagOf(resource);

  if (resource !== null && resourceTag === 'ri:page') {
    const title = riAttr(resource, 'content-title') ?? '';
    const spaceKey = riAttr(resource, 'space-key') ?? ctx.spaceKey;

    // A link to a page in the vault becomes a wikilink, which is what gives the
    // mirror a graph and backlinks (FR-4.7). Anything else stays an absolute URL.
    const linked = wikilink(element, { spaceKey, title }, ctx);
    if (linked !== null) return linked;

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
    return preserveAsHtml(element, ctx);
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
    return preserveAsHtml(element, ctx);
  }

  return {
    type: 'link',
    url: href,
    title: element.getAttribute('title'),
    children: ctx.convertPhrasing(childrenOf(element)),
  };
}

/**
 * Preserves an `ac:`-namespaced wrapper around content that stays readable.
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
 * Preserves a plain-HTML wrapper as itself: its own tags, with the content
 * converted normally in between.
 *
 * Storage format is XHTML and Markdown allows inline HTML, so `<span
 * style="color: rgb(255,0,0);">` can simply *be* itself — the reverse pass hands
 * an `html` node straight back, making the round trip exact, and Obsidian
 * renders the span in reading view and Live Preview alike. It reads as red text,
 * not as two opaque tokens with prose trapped between them.
 *
 * Only for elements with no namespaced markup of their own; `ac:` and `ri:` tags
 * would render as nothing at all (FR-4.9) and must stay in fragments.
 */
function preserveAsHtml(element: Element, ctx: ConversionContext): PhrasingContent[] {
  return [
    { type: 'html', value: serialiseStartTag(element, FAITHFUL) },
    ...ctx.convertPhrasing(childrenOf(element)),
    { type: 'html', value: serialiseEndTag(element) },
  ];
}

/**
 * A span is written out as itself.
 *
 * Whether it carries anything is settled before conversion: the §6.4.6 pass
 * unwraps every span whose style only restated a default, which on space EP was
 * 23 303 of 42 101 of them. Whatever survives is real formatting, and it renders
 * as that formatting rather than as a pair of tokens.
 */
function convertSpan(element: Element, ctx: ConversionContext): PhrasingContent[] {
  return preserveAsHtml(element, ctx);
}

/**
 * Preserves a construct with no Markdown equivalent, named as usefully as it can
 * be.
 *
 * A macro's `ac:name` is the informative part — `viewdoc`, `jira`, `toc` — and the
 * tag is the same string for all of them. Naming the tag instead put
 * `ac:structured-macro: 250` in front of the reader, which says nothing about what
 * is missing (FR-4.5).
 */
function preserveUnknown(element: Element, ctx: ConversionContext): PhrasingContent {
  const tag = tagOf(element);
  const macro = tag === 'ac:structured-macro' ? acAttr(element, 'name') : null;

  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'unsupported',
    name: macro ?? tag,
    label: macro === null ? `${tag}: ${collapse(textOf(element), 40)}` : `${macro} macro`,
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
      return convertImage(element, ctx);
    case 'time':
      return makeInlinePlaceholder(ctx.placeholders, element, {
        type: 'date',
        label: `date: ${element.getAttribute('datetime') ?? ''}`,
      });
    default:
      // A wrapper preserved whole would hide the prose inside it, so wrappers
      // are preserved as a pair instead. Everything else — self-contained
      // constructs whose inner markup is not readable text — is preserved whole.
      return WRAPPER_TAGS.has(tag) ? preserveAsHtml(element, ctx) : preserveUnknown(element, ctx);
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

/**
 * Writes hard breaks as `<br/>` when the run also contains inline HTML.
 *
 * `remark-stringify` renders a hard break as `\` followed by a newline — except
 * next to inline HTML, where it emits `\` followed by a *space*. A backslash
 * before a space is not an escape in Markdown, so it re-parses as a literal
 * backslash and the line break is **gone**: `<span>a</span><br/><span>b</span>`
 * came back as `<span>a</span>\ <span>b</span>`.
 *
 * Only when HTML is present, so ordinary prose keeps the tidier `\` form.
 */
function htmlBreaksBesideHtml(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  return nodes.map((node, index) => {
    if (node.type !== 'break') return node;

    // Adjacency, not presence. Converting every break in any run that held HTML
    // *anywhere* turned a whole paragraph of line breaks into one line of raw
    // `<br/>` tags the moment it contained a single coloured word — 6 787 of them
    // across space EP, where 462 had been enough.
    const beside = nodes[index - 1]?.type === 'html' || nodes[index + 1]?.type === 'html';
    return beside ? { type: 'html' as const, value: '<br/>' } : node;
  });
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

  return separateAdjacentCode(htmlBreaksBesideHtml(htmlTrailingBreak(output)));
}
