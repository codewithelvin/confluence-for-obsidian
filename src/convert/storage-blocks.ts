import type { BlockContent, Heading, List, ListItem, RootContent } from 'mdast';
import { convertMacro } from './macro-handlers';
import { makeBlockPlaceholder } from './placeholder-factory';
import { childrenOf, tagOf } from './storage-parser';
import type { ConversionContext } from './types';
import { convertTable } from './storage-tables';

/**
 * Block-level conversion, storage format to mdast (spec §6.4.2).
 *
 * Loose inline content between block elements is grouped into paragraphs, so a
 * body mixing text and elements at the top level converts cleanly.
 */

const HEADINGS: Record<string, Heading['depth']> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'hr',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ac:structured-macro',
  'ac:task-list',
  'ac:layout',
]);

const BLOCK_CONTENT_TYPES = new Set([
  'blockquote',
  'code',
  'heading',
  'html',
  'list',
  'thematicBreak',
  'paragraph',
  'table',
]);

function asBlockContent(nodes: readonly RootContent[]): BlockContent[] {
  return nodes.filter((node): node is BlockContent => BLOCK_CONTENT_TYPES.has(node.type));
}

function elementsOf(node: Node): Element[] {
  return childrenOf(node).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);
}

function isBlockElement(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(tagOf(node as Element));
}

function convertList(element: Element, ctx: ConversionContext): List {
  const items: ListItem[] = elementsOf(element)
    .filter((child) => tagOf(child) === 'li')
    .map((li) => ({
      type: 'listItem',
      spread: false,
      checked: null,
      children: asBlockContent(convertMixedContent(childrenOf(li), ctx)),
    }));

  return {
    type: 'list',
    ordered: tagOf(element) === 'ol',
    start: tagOf(element) === 'ol' ? 1 : null,
    spread: false,
    children: items,
  };
}

/**
 * Converts a Confluence task list to a GFM task list, carrying the task id in a
 * trailing HTML comment. The id is invisible in reading view but survives the
 * round trip, so a page with tasks stays editable instead of read-only.
 */
function convertTaskList(element: Element, ctx: ConversionContext): List {
  const items: ListItem[] = [];

  for (const task of elementsOf(element)) {
    if (tagOf(task) !== 'ac:task') continue;

    let id = '';
    let complete = false;
    let body: Element | null = null;

    for (const part of elementsOf(task)) {
      const tag = tagOf(part);
      if (tag === 'ac:task-id') id = (part.textContent ?? '').trim();
      else if (tag === 'ac:task-status') complete = (part.textContent ?? '').trim() === 'complete';
      else if (tag === 'ac:task-body') body = part;
    }

    const inline = body === null ? [] : ctx.convertPhrasing(childrenOf(body));
    const marker = id.length > 0 ? [{ type: 'html' as const, value: `<!--cf-task:${id}-->` }] : [];

    items.push({
      type: 'listItem',
      spread: false,
      checked: complete,
      children: [{ type: 'paragraph', children: [...inline, ...marker] }],
    });
  }

  return { type: 'list', ordered: false, start: null, spread: false, children: items };
}

function convertBlockElement(element: Element, ctx: ConversionContext): RootContent[] {
  const tag = tagOf(element);
  const depth = HEADINGS[tag];

  if (depth !== undefined) {
    return [{ type: 'heading', depth, children: ctx.convertPhrasing(childrenOf(element)) }];
  }

  switch (tag) {
    case 'p':
      return [{ type: 'paragraph', children: ctx.convertPhrasing(childrenOf(element)) }];
    case 'ul':
    case 'ol':
      return [convertList(element, ctx)];
    case 'ac:task-list':
      return [convertTaskList(element, ctx)];
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          children: asBlockContent(convertMixedContent(childrenOf(element), ctx)),
        },
      ];
    case 'hr':
      return [{ type: 'thematicBreak' }];
    case 'pre':
      // Deliberately preserved rather than converted to a fence. A bare fence
      // is indistinguishable from a code macro with no language, so converting
      // both would make one of them impossible to reproduce. Confluence writes
      // code macros, not <pre>, so this path is rare and costs little.
      return [
        makeBlockPlaceholder(ctx.placeholders, element, {
          type: 'preformatted',
          label: 'preformatted block',
        }),
      ];
    case 'table':
      return [convertTable(element, ctx)];
    case 'ac:structured-macro':
      return [convertMacro(element, ctx)];
    case 'div':
      // An unstyled div is pure structure; a styled one carries meaning we
      // cannot express, so it is preserved instead.
      return element.attributes.length === 0
        ? convertMixedContent(childrenOf(element), ctx)
        : [makeBlockPlaceholder(ctx.placeholders, element, { type: 'div', label: 'styled block' })];
    default:
      return [
        makeBlockPlaceholder(ctx.placeholders, element, {
          type: tag === 'ac:layout' ? 'layout' : 'unsupported',
          name: tag,
          label: tag === 'ac:layout' ? 'page layout' : `${tag} element`,
        }),
      ];
  }
}

/**
 * Converts a run of nodes that may mix block elements and loose inline content,
 * grouping consecutive inline nodes into paragraphs.
 */
export function convertMixedContent(nodes: readonly Node[], ctx: ConversionContext): RootContent[] {
  const output: RootContent[] = [];
  let pending: Node[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const inline = ctx.convertPhrasing(pending);
    pending = [];
    if (inline.length > 0) output.push({ type: 'paragraph', children: inline });
  };

  for (const node of nodes) {
    if (isBlockElement(node)) {
      flush();
      output.push(...convertBlockElement(node as Element, ctx));
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim().length === 0) {
      continue;
    }
    pending.push(node);
  }

  flush();
  return output;
}
