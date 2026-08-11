import type { PhrasingContent, RootContent, Table, TableCell, TableRow } from 'mdast';
import { makeBlockPlaceholder } from './placeholder-factory';
import { acAttr, childrenOf, hasNamespacedMarkup, tagOf } from './storage-parser';
import { FAITHFUL, serialiseElement } from './storage-serialiser';
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

/**
 * Marks a cell that was a `<th>` outside the header row.
 *
 * An HTML comment, so it is invisible in Reading View and Live Preview, and the
 * same device the task-list converter already uses to carry a Confluence task id
 * through a GFM checkbox. It is removed again on the way back to storage format.
 */
export const ROW_HEADER_MARKER = '<!--cf-th-->';

/**
 * Markers recording a page layout's shape while its content is unwrapped
 * (spec §6.4.8).
 *
 * HTML comments, so a reader never sees them in Reading View or Live Preview, and
 * the reverse pass rebuilds `ac:layout` from them exactly — a page keeps its
 * columns in Confluence even though Obsidian cannot show them.
 */
export const LAYOUT_OPEN = '<!--cf-layout-->';
export const LAYOUT_CLOSE = '<!--cf-layout-end-->';
export const LAYOUT_CELL = '<!--cf-layout-cell-->';
/** Carries the section's `ac:type`, so `two_equal` survives the round trip. */
export const LAYOUT_SECTION = '<!--cf-layout-section:';

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

/** One cell of a table that can be written as GFM. */
interface SimpleCell {
  readonly nodes: readonly Node[];
  /**
   * A `<th>` outside the header row — Confluence's row headers, which these
   * specification pages use constantly for a leading label column.
   *
   * GFM has no way to mark one, so it is carried in the cell as an HTML comment
   * and restored on the way back (§6.4.2, ROW_HEADER_MARKER). Without it the
   * reverse pass wrote `<td>`, the reproduced table no longer matched the
   * original, and every page holding such a table became read-only.
   */
  readonly isRowHeader: boolean;
}

interface SimpleTable {
  readonly rows: readonly (readonly SimpleCell[])[];
}

/**
 * Returns the cell grid when the table is representable as GFM, `null`
 * otherwise. Requires a full header row, uniform width, no spans, and inline
 * content only.
 */
export function analyseTable(table: Element): SimpleTable | null {
  // Confluence tables routinely carry `class="wrapped"` and a `<colgroup>` of
  // percentage column widths, and cells carry highlight classes. A GFM table
  // can express none of it. Converting anyway would drop real formatting and
  // make the whole page read-only; preserving the table keeps the prose around
  // it editable, at the cost of the table itself being opaque until the
  // placeholder renderer can display it.
  if (table.attributes.length > 0) return null;
  if (elementsOf(table).some((child) => tagOf(child) === 'colgroup')) return null;

  const rows = rowsOf(table);
  if (rows.length === 0) return null;

  const headerCells = elementsOf(rows[0] as Element);
  if (headerCells.length === 0) return null;
  if (!headerCells.every((cell) => tagOf(cell) === 'th')) return null;

  const width = headerCells.length;
  const grid: SimpleCell[][] = [];

  for (const [index, row] of rows.entries()) {
    const cells = elementsOf(row).filter((cell) => tagOf(cell) === 'td' || tagOf(cell) === 'th');
    if (cells.length !== width) return null;

    const converted: SimpleCell[] = [];
    for (const cell of cells) {
      if (hasSpan(cell)) return null;
      // Cell attributes carry highlight colours and titles a Markdown table
      // cannot hold.
      if (cell.attributes.length > 0) return null;
      const inline = cellInlineNodes(cell);
      if (inline === null) return null;
      converted.push({ nodes: inline, isRowHeader: index > 0 && tagOf(cell) === 'th' });
    }
    grid.push(converted);
  }

  return { rows: grid };
}

/**
 * Makes converted content safe to put in a GFM cell.
 *
 * A Markdown hard break cannot exist inside a table row — there is nowhere for
 * the newline to go — so `remark-stringify` writes it as a plain space and the
 * line break is **gone**, silently, from a cell that had one. Written as `<br/>`
 * instead it survives, renders in Obsidian, and reproduces exactly.
 *
 * Only reachable since §6.4.6 started freeing real tables; before that a cell
 * like this lived inside an opaque placeholder where nothing touched it.
 */
function asCellContent(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  return nodes.map((node) => (node.type === 'break' ? { type: 'html', value: '<br/>' } : node));
}

/**
 * An inline comment's anchor, carried through the note as an HTML comment.
 *
 * `ac:inline-comment-marker` is where a Confluence inline comment is pinned; it
 * renders as a yellow highlight over text that is otherwise ordinary. Being
 * `ac:`-namespaced, it disqualified its whole table from the HTML projection
 * below: of the mirror's 1 655 preserved tables 162 hold an anchor, and for 107
 * of them a highlight on two words was the only thing standing between a reader
 * and the table — including the longest acceptance-criteria table in VOEN's
 * POS-terminal specification, 16 bullets hidden behind two highlighted phrases.
 *
 * An HTML comment is invisible in Reading View and Live Preview, and survives a
 * round trip through Markdown untouched — the same device already carrying a row
 * header and a layout's shape. The anchor is therefore *kept*, not dropped:
 * pushing the page back reinstates the marker exactly, and the comment stays
 * attached to the words it was written about.
 */
const INLINE_COMMENT_MARKER = 'ac:inline-comment-marker';
const COMMENT_ANCHOR_OPEN = 'cf-comment:';
const COMMENT_ANCHOR_CLOSE = 'cf-comment-end';

/**
 * Refs safe to put inside an HTML comment. Confluence writes a UUID; anything
 * that could close the comment early, or that carries more than a ref, keeps the
 * marker as it is and the table stays preserved.
 */
const SAFE_REF = /^[A-Za-z0-9-]+$/;

/**
 * A copy of the table with every inline-comment anchor turned into a comment
 * pair, or `null` when one of them cannot be carried that way.
 *
 * A copy rather than the table itself: the original still has to be serialisable
 * verbatim into a fragment if the projection is refused further down.
 */
function hideCommentAnchors(table: Element): Element | null {
  if (table.getElementsByTagName(INLINE_COMMENT_MARKER).length === 0) return table;

  const clone = table.cloneNode(true) as Element;
  const document = clone.ownerDocument;

  for (const marker of Array.from(clone.getElementsByTagName(INLINE_COMMENT_MARKER))) {
    const ref = acAttr(marker, 'ref');
    const parent = marker.parentNode;
    if (parent === null) return null;
    if (marker.attributes.length !== 1 || ref === null || !SAFE_REF.test(ref)) return null;

    parent.insertBefore(document.createComment(`${COMMENT_ANCHOR_OPEN}${ref}`), marker);
    while (marker.firstChild !== null) parent.insertBefore(marker.firstChild, marker);
    parent.insertBefore(document.createComment(COMMENT_ANCHOR_CLOSE), marker);
    parent.removeChild(marker);
  }
  return clone;
}

/**
 * Puts the inline-comment anchors back, on the way to Confluence.
 *
 * The exact inverse of `hideCommentAnchors`, and it has to stay exact: a page
 * whose table came back without its anchors would no longer reproduce, and
 * certification would take the push away from it.
 */
export function restoreCommentAnchors(html: string): string {
  if (!html.includes(COMMENT_ANCHOR_OPEN)) return html;

  return html
    .replace(
      new RegExp(`<!--${COMMENT_ANCHOR_OPEN}([A-Za-z0-9-]+)-->`, 'g'),
      `<${INLINE_COMMENT_MARKER} ac:ref="$1">`,
    )
    .replace(new RegExp(`<!--${COMMENT_ANCHOR_CLOSE}-->`, 'g'), `</${INLINE_COMMENT_MARKER}>`);
}

/**
 * A table GFM cannot express, written into the note as the HTML it already is
 * (spec FR-4.10, decision D15).
 *
 * Storage format *is* XHTML and Markdown allows block HTML, so a table with
 * merged cells can simply *be* itself: Obsidian renders `colspan` and `rowspan`,
 * the reverse pass hands an `html` node straight back, and the round trip is
 * exact. 4 733 of space EP's 5 414 preserved tables — 87.4% — qualify.
 *
 * `null` when the table holds `ac:`- or `ri:`-namespaced markup, which Obsidian
 * renders as *nothing* (FR-4.9): writing such a table out would show empty cells
 * where an image or a link belongs, which is worse than an honest placeholder.
 * An inline comment's anchor is the exception — it wraps ordinary text and can
 * travel as an HTML comment instead, so it is not what makes a table opaque.
 */
function tableAsHtml(table: Element): RootContent | null {
  if (isIndented(table)) return null;

  const projected = hideCommentAnchors(table);
  if (projected === null || hasNamespacedMarkup(projected)) return null;

  return { type: 'html', value: serialiseElement(projected, FAITHFUL) };
}

/**
 * Containers that indent their content in Markdown, where a raw HTML block stops
 * being reliable.
 *
 * A list item or a quote writes its content behind `- ` or `> `, and an HTML block
 * inside that runs until a blank line — so the lines *after* the table get
 * swallowed into it and the body no longer reproduces. A placeholder there is
 * honest; a table that eats the paragraph following it is not.
 */
const INDENTING_ANCESTORS = new Set(['li', 'blockquote']);

function isIndented(element: Element): boolean {
  for (let node = element.parentNode; node !== null; node = node.parentNode) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (INDENTING_ANCESTORS.has(tagOf(node as Element))) return true;
  }
  return false;
}

export function convertTable(table: Element, ctx: ConversionContext): RootContent {
  const analysed = analyseTable(table);
  if (analysed === null) {
    // GFM cannot hold it, but HTML can — and a visible table beats a labelled
    // widget hiding what is often the whole point of the page.
    return (
      tableAsHtml(table) ??
      makeBlockPlaceholder(ctx.placeholders, table, {
        type: 'table',
        label: 'table containing Confluence macros, images or links',
      })
    );
  }

  const rows: TableRow[] = analysed.rows.map((cells) => ({
    type: 'tableRow',
    children: cells.map((cell): TableCell => {
      const children = asCellContent(ctx.convertPhrasing(cell.nodes));
      return {
        type: 'tableCell',
        children: cell.isRowHeader
          ? [...children, { type: 'html', value: ROW_HEADER_MARKER }]
          : children,
      };
    }),
  }));

  const result: Table = { type: 'table', align: null, children: rows };
  return result;
}
