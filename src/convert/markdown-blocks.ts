import type {
  Blockquote,
  BlockContent,
  Code,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
} from 'mdast';
import { restoreEmoticons } from './emoticons';
import { isParamsOnly, parseMacroParams } from './macro-params';
import {
  BLOCK_FENCE_LANGUAGE,
  readBlockCarrierId,
  readBlockPlaceholderId,
  readCarriedPreId,
} from './placeholder-registry';
import { escapeText } from './storage-serialiser';
import { restoreTableMedia } from './table-media';
import {
  LAYOUT_CELL,
  LAYOUT_CLOSE,
  LAYOUT_OPEN,
  LAYOUT_SECTION,
  restoreCommentAnchors,
  ROW_HEADER_MARKER,
} from './storage-tables';
import type { ReverseContext } from './types';

/**
 * Block-level conversion, mdast to storage format.
 *
 * The inverse of `storage-blocks.ts`. Every mapping here must be the exact
 * inverse of the forward one, or the fidelity checks will report drift on
 * content the user never touched.
 */

/** Panel macros reachable from an Obsidian callout. */
const PANEL_KINDS = new Set(['info', 'note', 'warning', 'tip']);

const CALLOUT_PATTERN = /^\[!([A-Za-z]+)\]([+-]?)[ \t]*([^\n]*)([\s\S]*)$/;

/** Confluence stamps this on macros it generates; emitted so bodies match. */
const SCHEMA_VERSION = ' ac:schema-version="1"';

function macroElement(name: string, inner: string): string {
  return `<ac:structured-macro ac:name="${name}"${SCHEMA_VERSION}>${inner}</ac:structured-macro>`;
}

function parameterElement(name: string, value: string): string {
  return `<ac:parameter ac:name="${name}">${escapeText(value)}</ac:parameter>`;
}

/** Wraps code text, preferring CDATA but falling back when it cannot nest. */
function plainTextBody(value: string): string {
  const body = value.includes(']]>') ? escapeText(value) : `<![CDATA[${value}]]>`;
  return `<ac:plain-text-body>${body}</ac:plain-text-body>`;
}

/**
 * A preserved block's source, or `''` with the id recorded — which fails the
 * whole conversion rather than pushing a page with a hole in it.
 */
function inflateBlock(id: string, ctx: ReverseContext): string {
  const fragment = ctx.fragments.get(id);
  if (fragment === undefined) {
    ctx.missingFragments.add(id);
    return '';
  }
  return fragment.xhtml;
}

function codeToStorage(node: Code, ctx: ReverseContext): string {
  if (node.lang === BLOCK_FENCE_LANGUAGE) {
    const id = readBlockPlaceholderId(node.value);
    if (id === null) {
      ctx.unsupported.add('a confluence-block placeholder with no readable id');
      return '';
    }
    return inflateBlock(id, ctx);
  }

  if (!isParamsOnly(node.meta)) {
    ctx.unsupported.add('a code fence with text after the language');
  }

  const params = parseMacroParams(node.meta);
  const language = node.lang ?? '';
  const parameters =
    (language.length > 0 ? parameterElement('language', language) : '') +
    Array.from(params.keys())
      .sort()
      .map((key) => parameterElement(key, params.get(key) ?? ''))
      .join('');

  return macroElement('code', parameters + plainTextBody(node.value));
}

interface Callout {
  readonly kind: string;
  readonly collapsible: boolean;
  readonly title: string;
  readonly body: readonly BlockContent[];
}

/** Recognises an Obsidian callout that maps onto a Confluence macro. */
function detectCallout(node: Blockquote, ctx: ReverseContext): Callout | null {
  const first = node.children[0];
  if (first?.type !== 'paragraph') return null;

  const lead = first.children[0];
  if (lead === undefined) return null;
  const leadText = lead.type === 'text' || lead.type === 'html' ? lead.value : null;
  if (leadText === null) return null;

  // `\[!info]` is literal text the user escaped, not a callout. mdast resolves
  // the escape, so the source has to be consulted — otherwise a quoted sentence
  // beginning with a bracket would be silently turned into a Confluence macro.
  const offset = lead.position?.start.offset;
  if (offset !== undefined && ctx.source[offset] === '\\') return null;

  const match = CALLOUT_PATTERN.exec(leadText);
  if (match === null) return null;

  const kind = (match[1] ?? '').toLowerCase();
  const collapsible = match[2] === '-';
  if (!PANEL_KINDS.has(kind)) return null;

  const remainder = (match[4] ?? '').replace(/^\n/, '');
  const rest: BlockContent[] = [];

  const tail = first.children.slice(1);
  if (remainder.trim().length > 0 || tail.length > 0) {
    rest.push({
      type: 'paragraph',
      children: [
        ...(remainder.length > 0 ? [{ type: 'text' as const, value: remainder }] : []),
        ...tail,
      ],
    });
  }
  rest.push(...(node.children.slice(1) as BlockContent[]));

  return { kind, collapsible, title: match[3] ?? '', body: rest };
}

function blockquoteToStorage(node: Blockquote, ctx: ReverseContext): string {
  const callout = detectCallout(node, ctx);
  if (callout === null) {
    return `<blockquote>${ctx.blocks(node.children)}</blockquote>`;
  }

  // A collapsible note is how the forward direction renders an expand macro.
  const name = callout.collapsible && callout.kind === 'note' ? 'expand' : callout.kind;
  const title = callout.title.length > 0 ? parameterElement('title', callout.title) : '';
  return macroElement(
    name,
    `${title}<ac:rich-text-body>${ctx.blocks(callout.body)}</ac:rich-text-body>`,
  );
}

/**
 * A list item's inner storage markup.
 *
 * The paragraph wrapper is dropped only when the paragraph is the item's *whole*
 * content, because that is exactly the case §6.4.5 declares equivalent —
 * `<li><p>x</p></li>` and `<li>x</li>` render identically and Confluence writes
 * both. An item that also holds a nested list or a table keeps its `<p>`: without
 * that, every step-with-sub-steps in a specification page reproduced as
 * `<li>Step<ul>…` against an original of `<li><p>Step</p><ul>…`, and the page
 * went read-only over a wrapper nobody can see.
 */
function listItemContent(item: ListItem, ctx: ReverseContext): string {
  const [first] = item.children;
  if (item.children.length === 1 && first?.type === 'paragraph') {
    return ctx.phrasing(first.children);
  }
  return ctx.blocks(item.children);
}

function taskListToStorage(node: List, ctx: ReverseContext): string {
  const tasks = node.children
    .map((item, index) => {
      const paragraph = item.children[0]?.type === 'paragraph' ? item.children[0] : null;
      let children = paragraph === null ? [] : [...paragraph.children];
      let id = String(index + 1);

      const last = children[children.length - 1];
      if (last?.type === 'html') {
        const match = /^<!--cf-task:(\d+)-->$/.exec(last.value.trim());
        if (match?.[1] !== undefined) {
          id = match[1];
          children = children.slice(0, -1);
        }
      }

      const status = item.checked === true ? 'complete' : 'incomplete';
      return (
        `<ac:task><ac:task-id>${id}</ac:task-id>` +
        `<ac:task-status>${status}</ac:task-status>` +
        `<ac:task-body>${ctx.phrasing(children)}</ac:task-body></ac:task>`
      );
    })
    .join('');

  return `<ac:task-list>${tasks}</ac:task-list>`;
}

function listToStorage(node: List, ctx: ReverseContext): string {
  const isTaskList = node.children.some((item) => item.checked === true || item.checked === false);
  if (isTaskList) return taskListToStorage(node, ctx);

  const tag = node.ordered === true ? 'ol' : 'ul';
  const items = node.children.map((item) => `<li>${listItemContent(item, ctx)}</li>`).join('');
  return `<${tag}>${items}</${tag}>`;
}

/**
 * Splits the row-header marker off a cell.
 *
 * The forward pass appends `<!--cf-th-->` to a `<th>` that sat outside the header
 * row, because GFM cannot mark one. Reading it back is what makes such a table
 * reproducible — and Confluence's specification tables label their first column
 * that way in row after row, so without it those pages were all read-only.
 */
function readRowHeader(cell: TableCell): { children: readonly PhrasingContent[]; header: boolean } {
  const last = cell.children[cell.children.length - 1];
  if (last?.type !== 'html' || last.value.trim() !== ROW_HEADER_MARKER) {
    return { children: cell.children, header: false };
  }
  return { children: cell.children.slice(0, -1), header: true };
}

function tableToStorage(node: Table, ctx: ReverseContext): string {
  const rows = node.children
    .map((row, index) => {
      const cells = row.children
        .map((cell) => {
          const { children, header } = readRowHeader(cell);
          const tag = index === 0 || header ? 'th' : 'td';
          return `<${tag}>${ctx.phrasing(children)}</${tag}>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<table><tbody>${rows}</tbody></table>`;
}

/** The marker text of an `html` node, or `null` for anything else. */
function markerOf(node: RootContent | undefined): string | null {
  return node?.type === 'html' ? node.value.trim() : null;
}

/**
 * Rebuilds `ac:layout` from the markers the forward pass left behind
 * (spec §6.4.7).
 *
 * Returns where the layout ended, so the caller resumes after it. An unclosed
 * layout — a user deleted the end marker — consumes the rest of the body rather
 * than silently dropping it; the re-parse guard in `markdownToStorage` then
 * catches any malformed result before it can reach Confluence.
 */
function layoutToStorage(
  nodes: readonly RootContent[],
  start: number,
  ctx: ReverseContext,
): { storage: string; next: number } {
  const sections: { type: string; cells: RootContent[][] }[] = [];
  let index = start + 1;

  for (; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) break;

    const marker = markerOf(node);
    if (marker === LAYOUT_CLOSE) {
      index += 1;
      break;
    }
    if (marker?.startsWith(LAYOUT_SECTION) === true) {
      const type = marker.slice(LAYOUT_SECTION.length, -'-->'.length);
      sections.push({ type, cells: [] });
      continue;
    }
    if (marker === LAYOUT_CELL) {
      sections[sections.length - 1]?.cells.push([]);
      continue;
    }

    const cells = sections[sections.length - 1]?.cells;
    cells?.[cells.length - 1]?.push(node);
  }

  const body = sections
    .map((section) => {
      const cells = section.cells
        .map((blocks) => `<ac:layout-cell>${ctx.blocks(blocks)}</ac:layout-cell>`)
        .join('');
      return `<ac:layout-section ac:type="${escapeText(section.type)}">${cells}</ac:layout-section>`;
    })
    .join('');

  return { storage: `<ac:layout>${body}</ac:layout>`, next: index };
}

/**
 * A raw HTML block: a table the forward pass wrote out as itself, a layout
 * marker, or HTML the user typed. Storage format is XHTML, so it goes back as it
 * is — apart from the inline-comment anchors, which travelled as HTML comments so
 * that Obsidian would not swallow the words they highlight.
 */
function htmlBlockToStorage(
  value: string,
  previous: RootContent | undefined,
  ctx: ReverseContext,
): string {
  // A block marker on a line of its own means the user deleted the embed in front
  // of it and left the marker. The macro goes back rather than vanishing, so a
  // diagram or an included page survives an edit that only looked like a
  // deletion (§6.4.8, §6.4.12).
  const block = readBlockCarrierId(value);
  if (block !== null) return inflateBlock(block, ctx);

  const carried = readCarriedPreId(value);
  // All three restorations are string-level and independent: a preserved table may
  // hold comment anchors, emoticons and shown images at once, and each has to come
  // back exactly (§6.4.9, §6.4.10).
  if (carried === null) {
    return restoreCommentAnchors(restoreEmoticons(restoreTableMedia(value, ctx)));
  }

  // The fence above has already used it — unless the user deleted the fence, in
  // which case the block goes back rather than disappearing.
  return previous?.type === 'code' ? '' : inflateBlock(carried, ctx);
}

/** An embed and nothing else — the shape the forward pass wrote for a diagram. */
const EMBED_ONLY = /^!\[\[[^[\]]+\]\]$/;

/**
 * The source of a block-level macro shown as a picture or as an included page, or
 * `null` for an ordinary paragraph (spec §6.4.8, §6.4.12).
 *
 * The paragraph is *replaced* by it, `<p>` and all, because the macro was a child
 * of the body: a wrapper Confluence never sent would fail certification and make
 * the page read-only.
 *
 * The embed has to still be there and be the only thing there. A user who typed
 * over it has written something the marker no longer describes, and inflating the
 * macro anyway would delete what they wrote; leaving the marker unread instead
 * carries it into the storage, where the push verifier stops the page.
 */
function carriedBlockMacro(
  children: readonly PhrasingContent[],
  ctx: ReverseContext,
): string | null {
  if (children.length !== 2) return null;

  const [embed, marker] = children;
  if (embed?.type !== 'text' || !EMBED_ONLY.test(embed.value.trim())) return null;
  if (marker?.type !== 'html') return null;

  const id = readBlockCarrierId(marker.value);
  return id === null ? null : inflateBlock(id, ctx);
}

export function blocksToStorage(nodes: readonly RootContent[], ctx: ReverseContext): string {
  let output = '';

  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    if (node === undefined) continue;

    // A layout spans many blocks, so it is consumed as a range rather than one
    // node at a time.
    if (markerOf(node) === LAYOUT_OPEN) {
      const layout = layoutToStorage(nodes, position, ctx);
      output += layout.storage;
      position = layout.next - 1;
      continue;
    }

    switch (node.type) {
      case 'paragraph':
        output += carriedBlockMacro(node.children, ctx) ?? `<p>${ctx.phrasing(node.children)}</p>`;
        break;
      case 'heading':
        output += `<h${String(node.depth)}>${ctx.phrasing(node.children)}</h${String(node.depth)}>`;
        break;
      case 'thematicBreak':
        output += '<hr/>';
        break;
      case 'code': {
        // A fence the forward pass wrote for a `<pre>` is marked by the comment
        // after it, and goes back as the block it came from rather than as the
        // code macro a bare fence would otherwise become.
        const carried = readCarriedPreId(markerOf(nodes[position + 1]) ?? '');
        output += carried === null ? codeToStorage(node, ctx) : inflateBlock(carried, ctx);
        break;
      }
      case 'blockquote':
        output += blockquoteToStorage(node, ctx);
        break;
      case 'list':
        output += listToStorage(node, ctx);
        break;
      case 'table':
        output += tableToStorage(node, ctx);
        break;
      case 'html':
        output += htmlBlockToStorage(node.value, nodes[position - 1], ctx);
        break;
      case 'definition':
      case 'footnoteDefinition':
        ctx.unsupported.add('a link definition or footnote');
        break;
      default:
        ctx.unsupported.add(`a ${String(node.type)} block`);
        break;
    }
  }

  return output;
}
