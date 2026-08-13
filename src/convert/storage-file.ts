import type { RootContent } from 'mdast';
import { makeBlockPlaceholder, preserveBeside } from './placeholder-factory';
import { carriedFile } from './placeholder-registry';
import { riAttr, tagOf } from './storage-parser';
import type { ConversionContext } from './types';
import { formatEmbed, isLinkable } from './wikilink';

/**
 * Document-preview macros, shown as the document (spec §6.4.13, D22, FR-4.20).
 *
 * `view-file` and its older siblings hold no content either: each names an
 * attachment and asks Confluence to draw a preview of it. So this is §6.4.12's
 * shape with an *attachment* where the include had a note — and it takes that
 * shape whole, embed and carrier and verbatim fragment, for the same reason: an
 * embed is what Obsidian offers that means "show me the thing over there".
 *
 * It is the largest single cause of an empty note in the mirror. Measured there:
 * **411 of these macros on 228 pages, 367 of them naming a file already in the
 * vault** — downloaded on the very pull that hid them, because FR-8.5 reads
 * `ri:filename` off the raw storage and has always seen these. 180 of those pages
 * had no other content at all: a title and two grey pills, while the `.docx` they
 * stood for sat one folder away.
 *
 * Pages carry two of them at once — `viewdoc` beside `view-file` for the same
 * file — which is what Confluence itself stores, and so what the note shows.
 */

/**
 * Macro names that stand for an attached document.
 *
 * `view-file` is the modern one; the rest are the per-format macros Confluence
 * shipped before it and still renders. All five are the same thing to this
 * converter: a name, and a preview drawn from the file it names.
 */
export const FILE_MACROS: ReadonlySet<string> = new Set([
  'view-file',
  'viewdoc',
  'viewxls',
  'viewppt',
  'viewpdf',
]);

/**
 * The attachment the macro names, or `null` when it names none.
 *
 * The name lives in an `ri:attachment` inside the `name` parameter, and all three
 * macro spellings the mirror holds write it that way — 411 of them, none with a
 * plain-text name. A macro with no body cannot hold a nested one, so a descendant
 * search cannot pick up someone else's file.
 *
 * The `ri:attachment` sometimes wraps an `<ri:content-entity>` naming the page the
 * file belongs to, which in principle points at *another* page's attachment and so
 * at a file this page's listing cannot answer for. Measured on the mirror: of 61
 * such references, 55 name this very page, and the 6 that do not are copied pages
 * whose own listing carries the same file under the same name — Confluence copies
 * attachments with the page. So the file name resolved against this page is the
 * right file in every case here, which is also the assumption FR-8.5 already makes
 * when it downloads by name from the page's own listing.
 */
export function fileTarget(macro: Element): string | null {
  for (const descendant of Array.from(macro.getElementsByTagName('*'))) {
    if (tagOf(descendant) !== 'ri:attachment') continue;

    const filename = riAttr(descendant, 'filename');
    if (filename !== null && filename.length > 0) return filename;
  }
  return null;
}

/**
 * What the widget says when the document cannot be shown (spec FR-4.14).
 *
 * The shared `macroLabel` ladder already reaches the file name for these, through
 * its `name` parameter and its `ri:attachment` fallback — but it reaches it by a
 * route that depends on which of the five macros this is, and the reader wants the
 * same sentence from all of them.
 */
function fileLabel(name: string, filename: string | null): string {
  return filename === null ? `${name} macro` : `${name} macro — ${filename}`;
}

/**
 * What the widget says when the document is named but not in the vault.
 *
 * The distinction matters to a reader and the old label hid it. `view-file macro —
 * Surəti Düzəliş.xlsx` reads like something this plugin failed to do; in fact that
 * file is not attached to page 98076055 at all and the reference is broken **in
 * Confluence too**, so no amount of work here could show it. Naming the state is the
 * difference between a widget that looks like a bug and one that tells the reader
 * where to go: re-attach the file at the source and it appears on the next pull.
 *
 * Deliberately *not* "not in Confluence". The converter is pure and cannot know why a
 * file is absent — FR-8.9 answers that in the sync report, where the reasons are
 * distinguishable. It knows only that it has nothing to embed, so that is all it says.
 */
function missingFileLabel(name: string, filename: string): string {
  return `${name} macro — ${filename} (not in the vault)`;
}

/**
 * The document as a block: a paragraph holding the embed and the marker that
 * stands for the macro.
 *
 * An embed rather than a link, for every file type. Obsidian previews a PDF inline
 * — which is what Confluence's widget does too — and falls back to a named,
 * clickable box for a format it cannot draw, which is also what Confluence's widget
 * does. One form therefore covers both, and it is the form §6.4.8's carrier
 * machinery already reads: `carriedBlockMacro` requires an embed and nothing else
 * in the paragraph, and admitting a second bracket form there would weaken the
 * guard that lets a *deleted* diagram come back.
 *
 * A placeholder wherever the file is not on disk — FR-4.17, the same condition
 * every other embed carries. An `ri:attachment` reference outlives the attachment
 * it names, and a box pointing at nothing is worse than an honest widget. The widget
 * **says** the file is not in the vault, so it does not read as a failure of this
 * plugin when the page is in fact broken at the source.
 */
export function convertFileBlock(
  macro: Element,
  name: string,
  ctx: ConversionContext,
): RootContent {
  const filename = fileTarget(macro);
  const path = filename === null ? null : (ctx.resolveAttachment?.(filename) ?? null);
  const onDisk = path !== null && path.length > 0;

  const label =
    filename !== null && !onDisk ? missingFileLabel(name, filename) : fileLabel(name, filename);
  const detail = { type: 'macro', name, label };

  if (path === null || !onDisk || !isLinkable(path)) {
    return makeBlockPlaceholder(ctx.placeholders, macro, detail);
  }

  // `carriedFile`, not `carriedBlock`: both replace the paragraph, so the reverse
  // pass reads them the same way, but a document embed sitting under
  // `<!--cf-drawio:…-->` would tell a reader of the source something untrue.
  const carried = preserveBeside(ctx.placeholders, macro, detail, 'block');
  return {
    type: 'paragraph',
    children: [{ type: 'html', value: `${formatEmbed(path, null)}${carriedFile(carried)}` }],
  };
}
