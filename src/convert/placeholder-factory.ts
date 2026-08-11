import type { Code, InlineCode } from 'mdast';
import {
  BLOCK_FENCE_LANGUAGE,
  blockPlaceholderBody,
  collapse,
  inlinePlaceholderValue,
  type PlaceholderRegistry,
} from './placeholder-registry';
import type { FragmentKind } from './types';
import {
  FAITHFUL,
  serialiseElement,
  serialiseEndTag,
  serialiseStartTag,
} from './storage-serialiser';

/**
 * Turns an unsupported construct into a placeholder, capturing its source
 * faithfully so push can re-inject it unchanged (spec FR-4.2).
 */

export interface PlaceholderDetail {
  readonly type: string;
  readonly label: string;
  readonly name?: string | null;
}

export function makeBlockPlaceholder(
  registry: PlaceholderRegistry,
  element: Element,
  detail: PlaceholderDetail,
): Code {
  const fragment = registry.add({
    kind: 'block',
    xhtml: serialiseElement(element, FAITHFUL),
    type: detail.type,
    name: detail.name ?? null,
    label: collapse(detail.label),
  });

  return {
    type: 'code',
    lang: BLOCK_FENCE_LANGUAGE,
    meta: null,
    value: blockPlaceholderBody(fragment),
  };
}

/**
 * Preserves a wrapper element as a pair of placeholders, so its contents stay
 * readable and editable while the wrapper itself round-trips exactly.
 *
 * Call `open` before converting the children and `close` after, so the ids stay
 * in document order and conversion remains repeatable.
 */
export function makeInlineOpen(
  registry: PlaceholderRegistry,
  element: Element,
  detail: PlaceholderDetail,
): InlineCode {
  const fragment = registry.add({
    kind: 'inline',
    xhtml: serialiseStartTag(element, FAITHFUL),
    type: detail.type,
    name: detail.name ?? null,
    label: collapse(detail.label),
  });
  return { type: 'inlineCode', value: inlinePlaceholderValue(fragment) };
}

export function makeInlineClose(
  registry: PlaceholderRegistry,
  element: Element,
  detail: PlaceholderDetail,
): InlineCode {
  const fragment = registry.add({
    kind: 'inline',
    xhtml: serialiseEndTag(element),
    type: detail.type,
    name: detail.name ?? null,
    label: `end of ${collapse(detail.label)}`,
  });
  return { type: 'inlineCode', value: inlinePlaceholderValue(fragment) };
}

/**
 * Preserves an element's source without standing in for it, returning the
 * fragment id so the caller can attach it to content of its own.
 *
 * Used where the construct *can* be shown — an attached image whose sizing or
 * border an embed cannot express — so the reader gets the picture and Confluence
 * still gets its markup back untouched. The alternative on both sides is worse:
 * an honest label nobody can see through, or a silent loss of the border.
 */
export function preserveBeside(
  registry: PlaceholderRegistry,
  element: Element,
  detail: PlaceholderDetail,
  kind: FragmentKind = 'inline',
): string {
  return registry.add({
    kind,
    xhtml: serialiseElement(element, FAITHFUL),
    type: detail.type,
    name: detail.name ?? null,
    label: collapse(detail.label),
  }).id;
}

export function makeInlinePlaceholder(
  registry: PlaceholderRegistry,
  element: Element,
  detail: PlaceholderDetail,
): InlineCode {
  const fragment = registry.add({
    kind: 'inline',
    xhtml: serialiseElement(element, FAITHFUL),
    type: detail.type,
    name: detail.name ?? null,
    label: collapse(detail.label),
  });

  return { type: 'inlineCode', value: inlinePlaceholderValue(fragment) };
}
