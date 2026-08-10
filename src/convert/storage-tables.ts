import type { RootContent, Table, TableCell, TableRow } from 'mdast';
import { makeBlockPlaceholder } from './placeholder-factory';
import { childrenOf, tagOf } from './storage-parser';
import type { ConversionContext } from './types';

/**
 * Table conversion (spec §6.4.2).
 *
 * GFM tables express only a rectangular grid of inline content with a header
 * row. Anything else — spans, nested blocks, or no header — is preserved as a
 * placeholder rather than approximated.
 *
 * Headerless tables become placeholders deliberately: GFM cannot represent one,
 * and synthesising an empty header would fail certification and so make the
 * whole page read-only. A single opaque table costs less than losing the ability
 * to edit the page around it.
 */

/** Content that cannot appear inside a GFM table cell. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ac:layout',
  'ac:structured-macro',
  'ac:task-list',
]);

function elementsOf(node: Node): Element[] {
  return childrenOf(node).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);
}

function isWhitespace(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim().length === 0;
}

function rowsOf(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of elementsOf(table)) {
    const tag = tagOf(child);
    if (tag === 'tr') rows.push(child);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      rows.push(...elementsOf(child).filter((row) => tagOf(row) === 'tr'));
    }
  }
  return rows;
}

/**
 * The nodes making up a cell's inline content, or `null` when the cell holds
 * block content. A cell wrapping everything in a single `<p>` is unwrapped,
 * since that is how Confluence writes an ordinary cell.
 */
function cellInlineNodes(cell: Element): readonly Node[] | null {
  const significant = childrenOf(cell).filter((child) => !isWhitespace(child));
  const only = significant.length === 1 ? significant[0] : undefined;
  const soleParagraph =
    only !== undefined && only.nodeType === Node.ELEMENT_NODE && tagOf(only as Element) === 'p'
      ? only
      : null;

  const nodes = soleParagraph === null ? significant : childrenOf(soleParagraph);

  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(tagOf(node as Element))) {
      return null;
    }
  }
  return nodes;
}

function hasSpan(cell: Element): boolean {
  const colspan = cell.getAttribute('colspan');
  const rowspan = cell.getAttribute('rowspan');
  return (colspan !== null && colspan !== '1') || (rowspan !== null && rowspan !== '1');
}

interface SimpleTable {
  readonly rows: readonly (readonly (readonly Node[])[])[];
}

/**
 * Returns the cell grid when the table is representable as GFM, `null`
 * otherwise. Requires a full header row, uniform width, no spans, and inline
 * content only.
 */
export function analyseTable(table: Element): SimpleTable | null {
  const rows = rowsOf(table);
  if (rows.length === 0) return null;

  const headerCells = elementsOf(rows[0] as Element);
  if (headerCells.length === 0) return null;
  if (!headerCells.every((cell) => tagOf(cell) === 'th')) return null;

  const width = headerCells.length;
  const grid: (readonly Node[])[][] = [];

  for (const row of rows) {
    const cells = elementsOf(row).filter((cell) => tagOf(cell) === 'td' || tagOf(cell) === 'th');
    if (cells.length !== width) return null;

    const converted: (readonly Node[])[] = [];
    for (const cell of cells) {
      if (hasSpan(cell)) return null;
      const inline = cellInlineNodes(cell);
      if (inline === null) return null;
      converted.push(inline);
    }
    grid.push(converted);
  }

  return { rows: grid };
}

export function convertTable(table: Element, ctx: ConversionContext): RootContent {
  const analysed = analyseTable(table);
  if (analysed === null) {
    return makeBlockPlaceholder(ctx.placeholders, table, {
      type: 'table',
      label: 'table with merged cells, block content, or no header row',
    });
  }

  const rows: TableRow[] = analysed.rows.map((cells) => ({
    type: 'tableRow',
    children: cells.map((nodes): TableCell => ({
      type: 'tableCell',
      children: ctx.convertPhrasing(nodes),
    })),
  }));

  const result: Table = { type: 'table', align: null, children: rows };
  return result;
}
