import type { BlockContent, Blockquote, Code, RootContent } from 'mdast';
import { serialiseMacroParams } from './macro-params';
import { makeBlockPlaceholder } from './placeholder-factory';
import { BLOCK_FENCE_LANGUAGE, collapse } from './placeholder-registry';
import { convertDiagramBlock, DIAGRAM_MACROS, macroLabel } from './storage-drawio';
import { convertIncludeBlock, INCLUDE_MACROS } from './storage-include';
import { acAttr, childrenOf, tagOf } from './storage-parser';
import type { ConversionContext } from './types';

/**
 * Macro conversion (spec §6.4.2).
 *
 * Only macros whose full meaning survives a round trip are converted. Every
 * other macro — and every macro carrying parameters this code does not model —
 * becomes a placeholder, so the page stays editable and the macro stays intact.
 */

/** Panel macros that map onto Obsidian callouts of the same name. */
const PANEL_MACROS = new Set(['info', 'note', 'warning', 'tip']);

const BLOCK_TYPES = new Set([
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
  return nodes.filter((node): node is BlockContent => BLOCK_TYPES.has(node.type));
}

function elementsOf(node: Node): Element[] {
  return childrenOf(node).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);
}

/** All `ac:parameter` values of a macro, keyed by name. */
export function macroParameters(macro: Element): Map<string, string> {
  const params = new Map<string, string>();
  for (const child of elementsOf(macro)) {
    if (tagOf(child) !== 'ac:parameter') continue;
    const name = acAttr(child, 'name');
    if (name !== null) params.set(name, child.textContent ?? '');
  }
  return params;
}

function bodyElement(macro: Element, tag: string): Element | null {
  return elementsOf(macro).find((child) => tagOf(child) === tag) ?? null;
}

/**
 * Builds an Obsidian callout. The marker is emitted as an mdast `html` node
 * because remark-stringify escapes `[` in ordinary text, which would turn
 * `[!info]` into `\[!info\]` and break the callout.
 */
function callout(
  kind: string,
  title: string | null,
  body: BlockContent[],
  collapsible: boolean,
): Blockquote {
  const suffix = collapsible ? '-' : '';
  const heading = title === null || title.length === 0 ? '' : ` ${collapse(title, 80)}`;

  return {
    type: 'blockquote',
    children: [
      { type: 'paragraph', children: [{ type: 'html', value: `[!${kind}]${suffix}${heading}` }] },
      ...body,
    ],
  };
}

function convertCodeMacro(macro: Element, ctx: ConversionContext): RootContent {
  const params = macroParameters(macro);
  const language = params.get('language') ?? '';
  params.delete('language');

  // A macro whose language is literally the placeholder fence language would
  // produce a fence indistinguishable from a placeholder.
  if (language === BLOCK_FENCE_LANGUAGE) {
    return makeBlockPlaceholder(ctx.placeholders, macro, {
      type: 'macro',
      name: 'code',
      label: `code macro whose language collides with the placeholder fence`,
    });
  }

  const body = bodyElement(macro, 'ac:plain-text-body');
  if (body === null) {
    return makeBlockPlaceholder(ctx.placeholders, macro, {
      type: 'macro',
      name: 'code',
      label: 'code macro with no body',
    });
  }

  const meta = serialiseMacroParams(params);
  const result: Code = {
    type: 'code',
    lang: language.length > 0 ? language : null,
    meta: meta.length > 0 ? meta : null,
    value: body.textContent ?? '',
  };
  return result;
}

function convertPanelMacro(macro: Element, name: string, ctx: ConversionContext): RootContent {
  const params = macroParameters(macro);
  const title = params.get('title') ?? null;
  params.delete('title');

  // A parameter this code does not model must not be silently dropped.
  if (params.size > 0) {
    return makeBlockPlaceholder(ctx.placeholders, macro, {
      type: 'macro',
      name,
      label: `${name} panel with unsupported parameters`,
    });
  }

  const body = bodyElement(macro, 'ac:rich-text-body');
  const children = body === null ? [] : asBlockContent(ctx.convertBlocks(childrenOf(body)));
  return callout(name, title, children, false);
}

function convertExpandMacro(macro: Element, ctx: ConversionContext): RootContent {
  const params = macroParameters(macro);
  const title = params.get('title') ?? null;
  params.delete('title');

  if (params.size > 0) {
    return makeBlockPlaceholder(ctx.placeholders, macro, {
      type: 'macro',
      name: 'expand',
      label: 'expand macro with unsupported parameters',
    });
  }

  const body = bodyElement(macro, 'ac:rich-text-body');
  const children = body === null ? [] : asBlockContent(ctx.convertBlocks(childrenOf(body)));
  return callout('note', title, children, true);
}

/** Converts a structured macro, or preserves it as a placeholder. */
export function convertMacro(macro: Element, ctx: ConversionContext): RootContent {
  const name = acAttr(macro, 'name') ?? '';

  if (name === 'code') return convertCodeMacro(macro, ctx);
  if (PANEL_MACROS.has(name)) return convertPanelMacro(macro, name, ctx);
  if (name === 'expand') return convertExpandMacro(macro, ctx);
  if (DIAGRAM_MACROS.has(name)) return convertDiagramBlock(macro, name, ctx);
  if (INCLUDE_MACROS.has(name)) return convertIncludeBlock(macro, name, ctx);

  return makeBlockPlaceholder(ctx.placeholders, macro, {
    type: 'macro',
    name: name.length > 0 ? name : null,
    label: macroLabel(macro, name),
  });
}
