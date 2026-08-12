import type { PhrasingContent, RootContent, Table, TableCell, TableRow } from 'mdast';
import { hideEmoticonsIn } from './emoticons';
import { makeBlockPlaceholder } from './placeholder-factory';
import { hideTableMediaIn } from './table-media';
import { acAttr, childrenOf, hasNamespacedMarkup, tagOf } from './storage-parser';
import { FAITHFUL, serialiseElement, WHITESPACE_PRESERVING } from './storage-serialiser';
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
 * Turns every inline-comment anchor in a *copy* of the table into a comment pair.
 *
 * Mutates, and returns `false` when one of them cannot be carried that way — the
 * caller then keeps the table preserved, and the original is still intact to be
 * serialised verbatim into a fragment.
 */
function hideCommentAnchorsIn(clone: Element): boolean {
  const document = clone.ownerDocument;

  for (const marker of Array.from(clone.getElementsByTagName(INLINE_COMMENT_MARKER))) {
    const ref = acAttr(marker, 'ref');
    const parent = marker.parentNode;
    if (parent === null) return false;
    if (marker.attributes.length !== 1 || ref === null || !SAFE_REF.test(ref)) return false;

    parent.insertBefore(document.createComment(`${COMMENT_ANCHOR_OPEN}${ref}`), marker);
    while (marker.firstChild !== null) parent.insertBefore(marker.firstChild, marker);
    parent.insertBefore(document.createComment(COMMENT_ANCHOR_CLOSE), marker);
    parent.removeChild(marker);
  }
  return true;
}

/** A blank line: a newline followed by another, with only spaces or tabs between. */
const BLANK_LINE = /\n[ \t]*(?:\n[ \t]*)+/g;

function hasBlankLine(text: string): boolean {
  return /\n[ \t]*\n/.test(text);
}

/**
 * Removes blank lines from a copy of the table, so it survives as one HTML block.
 *
 * A CommonMark HTML block **ends at a blank line**. A table written into the note
 * with one inside a cell is therefore cut in two: the remainder re-parses as
 * paragraphs, and the reproduced body loses the whitespace that separated them.
 * Measured on space EP, this is the single largest cause of an unpushable page —
 * 56% of the 592 notes holding an HTML table were read-only, against 6.6% of
 * notes without one.
 *
 * Rewriting the whitespace is free in certification terms because `CANONICAL`
 * collapses runs of whitespace on *both* sides of the comparison (§6.4.5): the
 * original's blank line and this single newline both become one space.
 *
 * Returns `false` when the blank line sits somewhere its whitespace is content —
 * inside a `<pre>` or a `<code>`. There the table cannot be an HTML block at all,
 * and an honest placeholder is the only correct answer.
 */
function removeBlankLines(node: Node, preserving: boolean): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (!hasBlankLine(text)) return true;
    if (preserving) return false;

    node.nodeValue = text.replace(BLANK_LINE, '\n');
    return true;
  }

  // A comment cannot be rewritten — its text is carried verbatim to Confluence —
  // so one holding a blank line refuses the projection instead.
  if (node.nodeType === Node.COMMENT_NODE) return !hasBlankLine(node.nodeValue ?? '');

  const inside =
    preserving ||
    (node.nodeType === Node.ELEMENT_NODE && WHITESPACE_PRESERVING.has(tagOf(node as Element)));

  return childrenOf(node).every((child) => removeBlankLines(child, inside));
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
/**
 * Either the table as an HTML node, or why it has to stay preserved.
 *
 * The reason is carried out rather than discarded because it becomes the
 * placeholder's label, and a label describing the wrong thing is its own bug: a
 * table refused over an unsplittable code block should not tell the reader it
 * contains macros.
 */
type Projection = { readonly node: RootContent } | { readonly reason: string };

/** Content Obsidian renders as nothing, so writing the table out would show gaps. */
const NAMESPACED = 'table containing Confluence macros, images or links';

/** A blank line the projection may not remove, so the table cannot be one block. */
const UNSPLITTABLE = 'table containing preformatted text broken by a blank line';

/**
 * The projection, or nothing allocated.
 *
 * `hideTableMediaIn` takes a fragment id per image it replaces, and two gates below
 * it still refuse the table afterwards — a macro left over, or a blank line that
 * cannot be removed. A refusal therefore has to give those ids back, or a table that
 * ended up a placeholder would leave its images in the sidecar with nothing pointing
 * at them and push the table's own id up past them. `planReplacements` makes the same
 * argument inside itself; this is that argument one level out.
 */
function tableAsHtml(table: Element, ctx: ConversionContext): Projection {
  const mark = ctx.placeholders.mark();
  const projection = projectTable(table, ctx);
  if (!('node' in projection)) ctx.placeholders.rollbackTo(mark);
  return projection;
}

function projectTable(table: Element, ctx: ConversionContext): Projection {
  const projected = table.cloneNode(true) as Element;
  if (!hideCommentAnchorsIn(projected)) return { reason: NAMESPACED };
  // Before the namespaced check, not after: an emoticon is namespaced markup that
  // Obsidian *can* show, and 20 tables in the mirror were opaque for no other
  // reason (§6.4.9, D18).
  if (!hideEmoticonsIn(projected)) return { reason: NAMESPACED };
  // Same argument one layer down, and a far larger one: 260 tables on 148 pages
  // hold an `ac:image` and nothing else worse (§6.4.10, D19).
  if (!hideTableMediaIn(projected, ctx)) return { reason: NAMESPACED };
  if (hasNamespacedMarkup(projected)) return { reason: NAMESPACED };
  if (!removeBlankLines(projected, false)) return { reason: UNSPLITTABLE };

  const html = serialiseElement(projected, FAITHFUL);
  // Last line of defence. Everything above works on the DOM, but an attribute
  // value can hold a newline too, and one blank line anywhere in the serialised
  // markup silently truncates the block.
  if (hasBlankLine(html)) return { reason: UNSPLITTABLE };

  return { node: { type: 'html', value: isIndented(table) ? `${html}\n` : html } };
}

/**
 * Containers that indent their content in Markdown.
 *
 * A list item or a quote writes its content behind `- ` or `> `, and Markdown puts
 * only a single newline between two blocks inside one — which does **not** end an
 * HTML block. Whatever follows the table is then swallowed into it: a paragraph
 * survives by luck, because §6.4.6 already claims bare text in a list item
 * equivalent to a wrapped `<p>`, but a nested list is reproduced as the literal
 * text `- sub` and the sub-list is gone.
 *
 * So an indented table carries a trailing newline, which makes the following line
 * blank and closes the block properly. That recovers **953** preserved tables in
 * the mirror, every one of which was opaque purely because of where it sat.
 *
 * Top-level tables do not get it: Markdown already separates top-level blocks by a
 * blank line, and adding another would put a visible gap under every table on the
 * 4 733 pages where the projection already worked.
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
    // GFM cannot hold it, but HTML usually can — and a visible table beats a
    // labelled widget hiding what is often the whole point of the page.
    const projected = tableAsHtml(table, ctx);
    return 'node' in projected
      ? projected.node
      : makeBlockPlaceholder(ctx.placeholders, table, {
          type: 'table',
          label: projected.reason,
        });
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
