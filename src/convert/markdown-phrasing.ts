import type { Link, PhrasingContent } from 'mdast';
import { CODE_SEPARATOR, readInlinePlaceholderId } from './placeholder-registry';
import { escapeAttribute, escapeText } from './storage-serialiser';
import type { ReverseContext } from './types';
import { formatWikilink, splitWikilinks, type Wikilink } from './wikilink';

/**
 * Inline conversion, mdast to storage format.
 *
 * Placeholders are re-inflated from the fragment cache verbatim — the whole
 * point of preserve-and-reinflate is that the plugin never rebuilds a construct
 * it did not fully understand.
 */

function inflateInline(value: string, ctx: ReverseContext): string | null {
  const id = readInlinePlaceholderId(value);
  if (id === null) return null;

  const fragment = ctx.fragments.get(id);
  if (fragment === undefined) {
    ctx.missingFragments.add(id);
    return '';
  }
  return fragment.xhtml;
}

function wrap(tag: string, children: readonly PhrasingContent[], ctx: ReverseContext): string {
  return `<${tag}>${ctx.phrasing(children)}</${tag}>`;
}

/**
 * Recognises a link that points back into Confluence, so it can be written as
 * an `ac:link` rather than a bare `<a href>`.
 *
 * Without this, an internal link would arrive as `ac:link` and leave as `<a>`,
 * which is not reversible and would make every page containing one read-only.
 */
function pageTarget(url: string, ctx: ReverseContext): { space: string; title: string } | null {
  const prefix = `${ctx.baseUrl}/display/`;
  if (!url.startsWith(prefix)) return null;

  const rest = url.slice(prefix.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;

  const titlePart = rest.slice(separator + 1);
  if (titlePart.length === 0 || titlePart.includes('/')) return null;

  try {
    return {
      space: decodeURIComponent(rest.slice(0, separator)),
      title: decodeURIComponent(titlePart.replace(/\+/g, '%20')),
    };
  } catch {
    // A malformed escape sequence means this is not a link we generated.
    return null;
  }
}

/**
 * Whether a link node came from a bare URL rather than link syntax.
 *
 * GFM turns any URL appearing in text into a link. Writing that back as an
 * anchor would invent markup the page never had — and inside a preserved
 * anchor whose text is a URL, it nests one anchor inside another. Markdown
 * link syntax starts with `[` and an angle autolink with `<`; anything else at
 * the node's offset was plain text.
 */
function isBareUrl(node: Link, source: string): boolean {
  const offset = node.position?.start.offset;
  if (offset === undefined) return false;

  const first = source[offset];
  return first !== '[' && first !== '<';
}

/** The `ri:page` resource for a page link. */
function pageResource(space: string, title: string): string {
  return (
    `<ri:page ri:content-title="${escapeAttribute(title)}"` +
    ` ri:space-key="${escapeAttribute(space)}"/>`
  );
}

/**
 * A page link whose visible text is plain.
 *
 * Text equal to the title is how a bodyless `ac:link` renders, so it must convert
 * back to a bodyless one. Shared by the Markdown-link and wikilink paths, which
 * have to produce byte-identical markup for the same link.
 */
function plainPageLink(space: string, title: string, text: string | null): string {
  const body =
    text === null || text === title
      ? ''
      : `<ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body>`;
  return `<ac:link>${pageResource(space, title)}${body}</ac:link>`;
}

function linkToStorage(node: Link, ctx: ReverseContext): string {
  if (isBareUrl(node, ctx.source)) return ctx.phrasing(node.children);

  const url = node.url;
  const children = node.children;
  const target = pageTarget(url, ctx);
  if (target === null) {
    // The title is part of the anchor, and dropping it lost the tooltip *and* the
    // page's push: `<a href="…" title="t">` reproduced as `<a href="…">`.
    const title = node.title === null || node.title === undefined ? '' : node.title;
    const attribute = title.length === 0 ? '' : ` title="${escapeAttribute(title)}"`;
    return `<a href="${escapeAttribute(url)}"${attribute}>${ctx.phrasing(children)}</a>`;
  }

  const onlyChild = children.length === 1 ? children[0] : undefined;
  if (onlyChild?.type === 'text') {
    return plainPageLink(target.space, target.title, onlyChild.value);
  }

  return (
    `<ac:link>${pageResource(target.space, target.title)}` +
    `<ac:link-body>${ctx.phrasing(children)}</ac:link-body></ac:link>`
  );
}

/**
 * Turns a wikilink back into the `ac:link` it came from (FR-4.7).
 *
 * An unresolvable path is left as the literal text it already is: the user may
 * simply have written `[[a note of my own]]`, and inventing a Confluence link out
 * of it would be worse than leaving it alone.
 */
function wikilinkToStorage(link: Wikilink, ctx: ReverseContext): string {
  const target = ctx.resolveVaultPath?.(link.path) ?? null;
  if (target === null) return escapeText(formatWikilink(link.path, link.label));

  return plainPageLink(target.spaceKey, target.title, link.label);
}

/**
 * Text, with any wikilinks in it converted.
 *
 * Wikilinks arrive as text because Markdown has no such syntax — `[[x]]` is a
 * link reference with no definition, which CommonMark leaves literal. Text with
 * none in it, which is nearly all of it, takes the fast path.
 */
function textToStorage(value: string, ctx: ReverseContext): string {
  const segments = splitWikilinks(value);
  const first = segments[0];
  if (segments.length === 1 && first?.kind === 'text') return escapeText(value);

  return segments
    .map((segment) =>
      segment.kind === 'text' ? escapeText(segment.value) : wikilinkToStorage(segment.link, ctx),
    )
    .join('');
}

/**
 * True for the separator the forward pass inserts between two adjacent code
 * spans. Dropped here so it never reaches Confluence. The check is scoped to
 * exactly that position, so a zero-width space a user genuinely typed survives.
 */
const AMBIGUOUS_WHEN_ADJACENT = new Set(['inlineCode', 'strong', 'emphasis', 'delete']);

function isCodeSeparator(nodes: readonly PhrasingContent[], index: number): boolean {
  const node = nodes[index];
  if (node?.type !== 'text' || node.value !== CODE_SEPARATOR) return false;

  const before = nodes[index - 1]?.type;
  const after = nodes[index + 1]?.type;
  return before !== undefined && before === after && AMBIGUOUS_WHEN_ADJACENT.has(before);
}

export function phrasingToStorage(nodes: readonly PhrasingContent[], ctx: ReverseContext): string {
  let output = '';

  for (const [index, node] of nodes.entries()) {
    if (isCodeSeparator(nodes, index)) continue;

    switch (node.type) {
      case 'text':
        output += textToStorage(node.value, ctx);
        break;
      case 'strong':
        output += wrap('strong', node.children, ctx);
        break;
      case 'emphasis':
        output += wrap('em', node.children, ctx);
        break;
      case 'delete':
        output += wrap('s', node.children, ctx);
        break;
      case 'inlineCode': {
        const inflated = inflateInline(node.value, ctx);
        output += inflated ?? `<code>${escapeText(node.value)}</code>`;
        break;
      }
      case 'link':
        output += linkToStorage(node, ctx);
        break;
      case 'break':
        output += '<br/>';
        break;
      case 'html':
        // Raw HTML the user wrote, or a marker this converter emitted. Passed
        // through unchanged; storage format is XHTML, so it is already valid.
        output += node.value;
        break;
      case 'image':
        // Uploading a new embed needs the attachment pipeline (M4). Reported
        // rather than silently dropped.
        ctx.unsupported.add('an embedded image');
        break;
      case 'imageReference':
      case 'linkReference':
        ctx.unsupported.add('a reference-style link or image');
        break;
      case 'footnoteReference':
        ctx.unsupported.add('a footnote');
        break;
      default:
        // Unreachable for the mdast version pinned here, but a future node type
        // must be reported rather than silently dropped.
        ctx.unsupported.add('an unrecognised inline element');
        break;
    }
  }

  return output;
}
