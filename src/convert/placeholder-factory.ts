import type { Code, InlineCode } from 'mdast';
import {
  BLOCK_FENCE_LANGUAGE,
  blockPlaceholderBody,
  collapse,
  inlinePlaceholderValue,
  type PlaceholderRegistry,
} from './placeholder-registry';
import { FAITHFUL, serialiseElement } from './storage-serialiser';

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
