import type { Image, Link, PhrasingContent } from 'mdast';
import { emoticonElement, emoticonGlyph, readEmoticonName } from './emoticons';
import {
  CODE_SEPARATOR,
  readCarriedImageId,
  readInlinePlaceholderId,
} from './placeholder-registry';
import { escapeAttribute, escapeText } from './storage-serialiser';
import type { ReverseContext } from './types';
import {
  formatEmbed,
  formatWikilink,
  parseEmbedSize,
  splitWikilinks,
  type Wikilink,
} from './wikilink';

/**
 * Inline conversion, mdast to storage format.
 *
 * Placeholders are re-inflated from the fragment cache verbatim — the whole
 * point of preserve-and-reinflate is that the plugin never rebuilds a construct
 * it did not fully understand.
 */

/**
 * A fragment's source, or `''` with the id recorded — which fails the whole
 * conversion in `markdownToStorage` rather than pushing a page with a hole in it.
 */
function inflateById(id: string, ctx: ReverseContext): string {
  const fragment = ctx.fragments.get(id);
  if (fragment === undefined) {
    ctx.missingFragments.add(id);
    return '';
  }
  return fragment.xhtml;
}

function inflateInline(value: string, ctx: ReverseContext): string | null {
  const id = readInlinePlaceholderId(value);
  return id === null ? null : inflateById(id, ctx);
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
 * Turns an embed back into the `ac:image` it came from (spec FR-8.2).
 *
 * A path that is not a known attachment stays literal text — the user may have
 * embedded a file of their own, and uploading it is FR-8.6, not this. The label
 * is a size or nothing: any other label is not a form this converter produced,
 * so it is left alone rather than guessed at.
 */
function embedToStorage(link: Wikilink, ctx: ReverseContext): string {
  const filename = ctx.attachmentFor?.(link.path) ?? null;
  const literal = escapeText(formatEmbed(link.path, link.label));
  if (filename === null) return literal;

  const size = link.label === null ? null : parseEmbedSize(link.label);
  if (link.label !== null && size === null) return literal;

  const height = size?.height ?? null;
  const attributes =
    size === null
      ? ''
      : ` ac:width="${escapeAttribute(size.width)}"` +
        (height === null ? '' : ` ac:height="${escapeAttribute(height)}"`);

  return (
    `<ac:image${attributes}>` +
    `<ri:attachment ri:filename="${escapeAttribute(filename)}"/></ac:image>`
  );
}

/**
 * Markdown's own `![](url)` syntax, back to the `ac:image` it came from.
 *
 * Not an Obsidian embed — a wikilink embed arrives as *text* and is handled in
 * `textToStorage`. This form points at a URL, which is exactly what `<ri:url>` is,
 * so the two are the same thing written two ways.
 *
 * The alt text carries the size and nothing else, because that is all the forward
 * pass ever puts there. A real caption cannot go into an `ac:image` this way, so it
 * is reported rather than dropped: `![diagram](…)` makes the page read-only until the
 * caption is removed, which is FR-5.2 refusing to change the user's words on the way
 * out. A relative URL is not an image Confluence can reach at all — the file would
 * have to be uploaded first, which is FR-8.6's job on an *embed*, not this.
 */
function imageToStorage(node: Image, ctx: ReverseContext): string {
  if (!/^https?:\/\//i.test(node.url)) {
    ctx.unsupported.add('an embedded image');
    return '';
  }

  const alt = node.alt ?? '';
  const size = alt.length === 0 ? null : parseEmbedSize(alt.replace(/^\|/, ''));
  if (alt.length > 0 && size === null) {
    ctx.unsupported.add('an image with a caption');
    return '';
  }

  const height = size?.height ?? null;
  const attributes =
    size === null
      ? ''
      : ` ac:width="${escapeAttribute(size.width)}"` +
        (height === null ? '' : ` ac:height="${escapeAttribute(height)}"`);

  return `<ac:image${attributes}>` + `<ri:url ri:value="${escapeAttribute(node.url)}"/></ac:image>`;
}

/**
 * Text, with any wikilink or embed in it converted.
 *
 * Both arrive as text because Markdown has no such syntax — `[[x]]` is a link
 * reference with no definition, which CommonMark leaves literal. Text with
 * neither in it, which is nearly all of it, takes the fast path.
 *
 * `carried` is the source of an image the embed shows but cannot describe — a
 * border, a thumbnail, a lone height. It replaces the *last* embed in the text,
 * which is the one the marker follows.
 */
function textToStorage(value: string, ctx: ReverseContext, carried: string | null = null): string {
  const segments = splitWikilinks(value);
  const first = segments[0];
  if (segments.length === 1 && first?.kind === 'text') return escapeText(value);

  const lastEmbed = segments.reduce(
    (found, segment, index) => (segment.kind === 'embed' ? index : found),
    -1,
  );

  return segments
    .map((segment, index) => {
      if (segment.kind === 'text') return escapeText(segment.value);
      if (segment.kind !== 'embed') return wikilinkToStorage(segment.link, ctx);
      if (carried !== null && index === lastEmbed) return carried;
      return embedToStorage(segment.link, ctx);
    })
    .join('');
}

/**
 * Whether a text node ends in an embed the marker after it could be describing.
 *
 * Only the last segment counts: the marker sits immediately behind its own embed,
 * so anything after that embed means the user has edited between the two and the
 * pairing can no longer be trusted.
 */
function endsInEmbed(node: PhrasingContent | undefined): boolean {
  if (node?.type !== 'text') return false;

  const segments = splitWikilinks(node.value);
  return segments[segments.length - 1]?.kind === 'embed';
}

/**
 * Raw HTML the user wrote, or a marker this converter emitted.
 *
 * Passed through unchanged — storage format is XHTML, so it is already valid —
 * except for a carried-image marker, which the embed in front of it has normally
 * already consumed.
 */
function htmlToStorage(
  value: string,
  previous: PhrasingContent | undefined,
  ctx: ReverseContext,
): string {
  const emoticon = readEmoticonName(value);
  if (emoticon !== null) {
    // Normally the text in front has already taken it. When that text no longer
    // ends in the glyph the user deleted the character and left the carrier, and
    // the emoticon goes back on its own rather than vanishing from the page.
    return endsInGlyph(previous, emoticon) ? '' : emoticonElement(emoticon);
  }

  const carried = readCarriedImageId(value);
  if (carried === null) return value;
  if (endsInEmbed(previous)) return '';

  // The embed it belonged to is gone — the user deleted the picture and left the
  // marker. Its source goes back on its own rather than being dropped, so the
  // image survives an edit that only looked like a deletion, and a real deletion
  // still shows up in the push diff.
  return inflateById(carried, ctx);
}

/** Whether the text before a carrier still ends in the glyph that carrier names. */
function endsInGlyph(node: PhrasingContent | undefined, name: string): boolean {
  const glyph = emoticonGlyph(name);
  return node?.type === 'text' && glyph !== null && node.value.endsWith(glyph);
}

/**
 * The emoticon a text node's trailing glyph stands for, with the glyph removed.
 *
 * `null` when the next node is not a carrier, or when the text no longer ends in
 * the right glyph — a user who typed ✅ of their own accord keeps it as text.
 */
function trailingEmoticon(
  value: string,
  next: PhrasingContent | undefined,
): { readonly text: string; readonly name: string } | null {
  if (next?.type !== 'html') return null;

  const name = readEmoticonName(next.value);
  const glyph = name === null ? null : emoticonGlyph(name);
  if (name === null || glyph === null || !value.endsWith(glyph)) return null;

  return { text: value.slice(0, value.length - glyph.length), name };
}

/** The source to put back in place of a text node's last embed, if one is marked. */
function carriedSource(
  marker: PhrasingContent | undefined,
  text: PhrasingContent,
  ctx: ReverseContext,
): string | null {
  if (marker?.type !== 'html' || !endsInEmbed(text)) return null;

  const id = readCarriedImageId(marker.value);
  return id === null ? null : inflateById(id, ctx);
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

/**
 * A text node, and whichever carrier the node after it turns out to be.
 *
 * Two carriers end up here because both describe something *inside* this text
 * rather than a node of their own: an emoticon's glyph, and the embed a
 * carried-image marker follows.
 */
function textNodeToStorage(
  node: PhrasingContent & { type: 'text' },
  next: PhrasingContent | undefined,
  ctx: ReverseContext,
): string {
  const emoticon = trailingEmoticon(node.value, next);
  if (emoticon !== null) {
    return textToStorage(emoticon.text, ctx) + emoticonElement(emoticon.name);
  }

  return textToStorage(node.value, ctx, carriedSource(next, node, ctx));
}

export function phrasingToStorage(nodes: readonly PhrasingContent[], ctx: ReverseContext): string {
  let output = '';

  for (const [index, node] of nodes.entries()) {
    if (isCodeSeparator(nodes, index)) continue;

    switch (node.type) {
      case 'text':
        output += textNodeToStorage(node, nodes[index + 1], ctx);
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
        output += htmlToStorage(node.value, nodes[index - 1], ctx);
        break;
      case 'image':
        output += imageToStorage(node, ctx);
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
