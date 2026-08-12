import type { PhrasingContent, RootContent } from 'mdast';
import { makeBlockPlaceholder, makeInlinePlaceholder, preserveBeside } from './placeholder-factory';
import { carriedImage, carriedInclude } from './placeholder-registry';
import { riAttr, tagOf } from './storage-parser';
import type { ConversionContext, PageTarget } from './types';
import { formatEmbed, isLinkable } from './wikilink';

/**
 * The include macro, shown as the page it names (spec §6.4.12, D21, FR-4.19).
 *
 * `include` is the third macro that holds no content of its own — `toc` and
 * `children` (§6.4.11) generate theirs from the page's headings and its position
 * in the tree, and this one names another page and shows that page's body. The
 * difference is that this one has an *exact* Obsidian construct rather than a
 * rebuilt approximation: an embed is a transclusion in the same sense, with the
 * same live update, and no rendering to write at all.
 *
 * So it is §6.4.8's shape one step out — a macro whose content is a *note* rather
 * than an attachment — and it takes that shape whole: the embed, the carrier
 * beside it, the fragment holding the macro verbatim, and a push that hands
 * Confluence back exactly what it sent.
 *
 * Measured on the mirror: 116 include macros on 12 pages, 112 of them naming a
 * page that is mirrored. On `Bildirişlər` (page 28603488) the macro is the whole
 * page — a heading and two pills standing for two entire documents.
 */

/** Macro names that stand for another page's body. */
export const INCLUDE_MACROS: ReadonlySet<string> = new Set(['include']);

/**
 * The page an include macro names, or `null` when it names none.
 *
 * The reference sits in an unnamed parameter — `<ac:parameter ac:name="">` — so
 * there is no parameter name to look it up by, and the `ri:page` itself is what
 * identifies it. A macro with no body cannot hold a nested one, so a descendant
 * search cannot pick up someone else's target.
 */
export function includeTarget(macro: Element, spaceKey: string): PageTarget | null {
  for (const descendant of Array.from(macro.getElementsByTagName('*'))) {
    if (tagOf(descendant) !== 'ri:page') continue;

    const title = riAttr(descendant, 'content-title');
    if (title === null || title.length === 0) continue;

    return { spaceKey: riAttr(descendant, 'space-key') ?? spaceKey, title };
  }
  return null;
}

/**
 * What the widget says when the page cannot be shown (spec FR-4.14).
 *
 * The shared `macroLabel` ladder reads *parameter values*, and an include's one
 * parameter is unnamed and holds an element rather than text — so every one of
 * these labelled itself `include macro` and told the reader nothing about which
 * page was missing. The title is the only thing that identifies it.
 */
function includeLabel(name: string, target: PageTarget | null): string {
  // `name` is never empty: the only way here is through `INCLUDE_MACROS.has(name)`,
  // so the unnamed-macro case `macroLabel` guards against cannot arise.
  return target === null ? `${name} macro` : `${name} macro — ${target.title}`;
}

/**
 * The included page as a block: a paragraph holding the embed and the marker that
 * stands for the macro.
 *
 * A placeholder wherever the vault cannot answer honestly — a page outside the
 * mirror, or one whose path holds a character a wikilink cannot carry. It is
 * deliberately *not* downgraded to an absolute Confluence URL the way a page link
 * in prose is (FR-4.7): a link means "there is more over there", while an include
 * that cannot be shown means the body of this page is missing, and the widget with
 * "Open in Confluence" is the honest way to say so.
 */
export function convertIncludeBlock(
  macro: Element,
  name: string,
  ctx: ConversionContext,
): RootContent {
  const target = includeTarget(macro, ctx.spaceKey);
  const detail = { type: 'macro', name, label: includeLabel(name, target) };

  const path = target === null ? null : (ctx.resolveTarget?.(target) ?? null);
  if (path === null || !isLinkable(path)) {
    return makeBlockPlaceholder(ctx.placeholders, macro, detail);
  }

  // `carriedInclude`, not `carriedBlock`: both replace the paragraph, so the
  // reverse pass reads them the same way, but a note embed sitting under
  // `<!--cf-drawio:…-->` would tell a reader of the source something untrue.
  const carried = preserveBeside(ctx.placeholders, macro, detail, 'block');
  return {
    type: 'paragraph',
    children: [{ type: 'html', value: `${formatEmbed(path, null)}${carriedInclude(carried)}` }],
  };
}

/**
 * The included page inline, where the macro sat inside a paragraph of Confluence's
 * own — which is 93 of the mirror's 116.
 *
 * Here the `<p>` *is* Confluence's, so this is exactly the carried-image case and
 * needs no read-back of its own: `carriedSource` replaces whatever embed the text
 * in front of it ends with, and has never cared what that embed points at.
 *
 * The marker is `carriedImage` rather than a fourth name. `cf-img` is already the
 * *positional* marker for "fill in this spot inside the paragraph" rather than an
 * image-specific one — D17 established that when it put an inline `drawio` macro
 * behind it. The block side needed `cf-inc` for the opposite reason: `cf-drawio`
 * names one macro, so a second user of it would have been a lie.
 *
 * Every one of the 93 shares its paragraph with nothing but other includes, 2 to 5
 * of them, so the note gets a run of embeds flush against one another — no code
 * separator, because that is only inserted between two nodes whose Markdown
 * delimiters would merge, and an embed's do not.
 */
export function convertIncludeInline(
  macro: Element,
  name: string,
  ctx: ConversionContext,
): PhrasingContent {
  const target = includeTarget(macro, ctx.spaceKey);
  const detail = { type: 'macro', name, label: includeLabel(name, target) };

  const path = target === null ? null : (ctx.resolveTarget?.(target) ?? null);
  if (path === null || !isLinkable(path)) {
    return makeInlinePlaceholder(ctx.placeholders, macro, detail);
  }

  const carried = preserveBeside(ctx.placeholders, macro, detail, 'inline');
  return { type: 'html', value: `${formatEmbed(path, null)}${carriedImage(carried)}` };
}
