import type { PhrasingContent } from 'mdast';
import { readInlinePlaceholderId } from './placeholder-registry';
import { escapeAttribute, escapeText } from './storage-serialiser';
import type { ReverseContext } from './types';

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

function linkToStorage(
  url: string,
  children: readonly PhrasingContent[],
  ctx: ReverseContext,
): string {
  const target = pageTarget(url, ctx);
  if (target === null) {
    return `<a href="${escapeAttribute(url)}">${ctx.phrasing(children)}</a>`;
  }

  const resource =
    `<ri:page ri:content-title="${escapeAttribute(target.title)}"` +
    ` ri:space-key="${escapeAttribute(target.space)}"/>`;

  const onlyChild = children.length === 1 ? children[0] : undefined;
  if (onlyChild?.type === 'text') {
    // Link text equal to the title is how a bodyless ac:link renders, so it
    // must convert back to a bodyless ac:link.
    const body =
      onlyChild.value === target.title
        ? ''
        : `<ac:plain-text-link-body><![CDATA[${onlyChild.value}]]></ac:plain-text-link-body>`;
    return `<ac:link>${resource}${body}</ac:link>`;
  }

  return `<ac:link>${resource}<ac:link-body>${ctx.phrasing(children)}</ac:link-body></ac:link>`;
}

export function phrasingToStorage(nodes: readonly PhrasingContent[], ctx: ReverseContext): string {
  let output = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        output += escapeText(node.value);
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
        output += linkToStorage(node.url, node.children, ctx);
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
