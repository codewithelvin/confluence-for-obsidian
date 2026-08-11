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
import { isParamsOnly, parseMacroParams } from './macro-params';
import { BLOCK_FENCE_LANGUAGE, readBlockPlaceholderId } from './placeholder-registry';
import { escapeText } from './storage-serialiser';
import { ROW_HEADER_MARKER } from './storage-tables';
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

function codeToStorage(node: Code, ctx: ReverseContext): string {
  if (node.lang === BLOCK_FENCE_LANGUAGE) {
    const id = readBlockPlaceholderId(node.value);
    if (id === null) {
      ctx.unsupported.add('a confluence-block placeholder with no readable id');
      return '';
    }
    const fragment = ctx.fragments.get(id);
    if (fragment === undefined) {
      ctx.missingFragments.add(id);
      return '';
    }
    return fragment.xhtml;
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

export function blocksToStorage(nodes: readonly RootContent[], ctx: ReverseContext): string {
  let output = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        output += `<p>${ctx.phrasing(node.children)}</p>`;
        break;
      case 'heading':
        output += `<h${String(node.depth)}>${ctx.phrasing(node.children)}</h${String(node.depth)}>`;
        break;
      case 'thematicBreak':
        output += '<hr/>';
        break;
      case 'code':
        output += codeToStorage(node, ctx);
        break;
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
        output += node.value;
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
