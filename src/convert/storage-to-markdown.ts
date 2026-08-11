import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';
import { discardInvisibleMarkup } from './discard';
import { PlaceholderRegistry } from './placeholder-registry';
import { convertMixedContent } from './storage-blocks';
import { childrenOf, parseStorage } from './storage-parser';
import { convertPhrasingNodes } from './storage-phrasing';
import type { ConversionContext, ConversionOptions, StorageToMarkdown } from './types';

export type { ConversionOptions };

/**
 * Storage format to Markdown (spec §6.4).
 *
 * Pure: no I/O, no clock, no randomness (spec §7.5). The same input always
 * produces byte-identical output (FR-4.8), which is what makes the fidelity
 * guarantees testable.
 */

/**
 * Fixed stringify settings. Determinism matters more than taste here: any
 * variation would show up as a spurious difference in the fidelity checks.
 */
const processor = unified().use(remarkGfm).use(remarkStringify, {
  bullet: '-',
  emphasis: '*',
  strong: '*',
  fences: true,
  listItemIndent: 'one',
  rule: '-',
  resourceLink: false,
});

export function storageToMarkdown(
  xhtml: string,
  options: ConversionOptions,
): Result<StorageToMarkdown, AppError> {
  const parsed = parseStorage(xhtml);
  if (!parsed.ok) return parsed;

  // Before anything is converted, so the whitelist below never has to reason
  // about markup that renders as nothing. `normaliseStorage` applies the very
  // same pass, which is what keeps certification honest (§6.4.5).
  if (options.strictMarkup !== true) discardInvisibleMarkup(parsed.value);

  const placeholders = new PlaceholderRegistry();
  // Spread rather than copied field by field: hand-copying silently dropped the
  // link resolvers when FR-4.7 added them, and the conversion carried on producing
  // absolute URLs with no error anywhere to say why.
  const context: ConversionContext = {
    ...options,
    placeholders,
    convertBlocks: (nodes) => convertMixedContent(nodes, context),
    convertPhrasing: (nodes) => convertPhrasingNodes(nodes, context),
  };

  const root: Root = {
    type: 'root',
    children: convertMixedContent(childrenOf(parsed.value), context),
  };

  return ok({
    markdown: processor.stringify(root),
    fragments: placeholders.snapshot(),
  });
}
