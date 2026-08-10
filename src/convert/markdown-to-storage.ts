import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import { blocksToStorage } from './markdown-blocks';
import { phrasingToStorage } from './markdown-phrasing';
import { parseStorage } from './storage-parser';
import type { ConversionOptions, FragmentMap, ReverseContext } from './types';

/**
 * Markdown to storage format (spec §6.4).
 *
 * Pure, and deliberately unforgiving: a note referencing a placeholder whose
 * fragment is no longer cached, or containing something storage format cannot
 * express, produces an error rather than a best-effort body. Push must never
 * write a body the plugin is not certain about (spec §10 rule 12).
 */

const parser = unified().use(remarkParse).use(remarkGfm);

function list(values: Iterable<string>): string {
  return Array.from(values).sort().join(', ');
}

export function markdownToStorage(
  markdown: string,
  fragments: FragmentMap,
  options: ConversionOptions,
): Result<string, AppError> {
  const root = parser.parse(markdown);

  const context: ReverseContext = {
    fragments,
    source: markdown,
    baseUrl: options.baseUrl,
    spaceKey: options.spaceKey,
    missingFragments: new Set<string>(),
    unsupported: new Set<string>(),
    blocks: (nodes) => blocksToStorage(nodes, context),
    phrasing: (nodes) => phrasingToStorage(nodes, context),
  };

  const storage = blocksToStorage(root.children, context);

  if (context.missingFragments.size > 0) {
    return err(
      new AppError(
        'FRAGMENT_MISSING',
        'This note references preserved Confluence content that is no longer cached ' +
          `(${list(context.missingFragments)}). Pull the page again before pushing.`,
        { action: 'repull-page' },
      ),
    );
  }

  if (context.unsupported.size > 0) {
    return err(
      new AppError(
        'VERIFICATION_FAILED',
        `This note contains ${list(context.unsupported)}, which cannot be written to ` +
          'Confluence. Remove it, or edit the page in Confluence instead.',
        { action: 'show-diff' },
      ),
    );
  }

  // Last line of defence. Preserved wrappers are written as a placeholder pair,
  // so deleting one half would leave unbalanced markup. Re-parsing catches that
  // — and any other way the output could be malformed — before it is ever sent.
  if (!parseStorage(storage).ok) {
    return err(
      new AppError(
        'VERIFICATION_FAILED',
        'Converting this note produced markup Confluence would reject, usually because a ' +
          'preserved block was only partly deleted. Undo the change, or pull the page again.',
        { action: 'show-diff' },
      ),
    );
  }

  return ok(storage);
}
