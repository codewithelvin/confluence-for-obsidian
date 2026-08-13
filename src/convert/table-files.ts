import { preserveBeside } from './placeholder-factory';
import { acAttr, tagOf } from './storage-parser';
import { fileTarget, FILE_MACROS } from './storage-file';
import { attachmentUrl } from './table-media';
import type { ConversionContext } from './types';

/**
 * Document-preview macros inside a preserved table (spec §6.4.17, D26, FR-4.24).
 *
 * §6.4.13 shows a `view-file` macro as an embed of the document it names — but only
 * at body level. Inside a preserved table the Markdown route is closed for §6.4.10's
 * reason, so the macro still refused the whole table, and the table on page 112363703
 * is seven of them: a four-column grid of the Word forms a taxpayer files for each
 * kind of change. All of it was one grey pill.
 *
 * The projection is §6.4.10's own: an `<a href>` at a vault path, which O18 proved
 * Obsidian renders inside a raw HTML block and which the client has since confirmed
 * opens the file in whatever application the operating system has for it. So there is
 * no new rendering question here — only the macro's own name to read.
 *
 * **A file that is not on disk degrades to its name rather than refusing the table.**
 * That is a deliberate departure from `hideTableMediaIn`'s all-or-nothing rule, and
 * the reason is that the rule's premise does not hold here. All-or-nothing exists so
 * a half-translated table cannot show a *gap* where FR-4.9 says it must not — but a
 * file name written as text is not a gap: the cell still says which document belongs
 * there, it simply does not link to it, which is exactly what the reader needs to know.
 * Page 112363703 is the case: four of its seven documents are in the vault, and
 * refusing on the other three would hide the four along with the whole grid of labels.
 */

/** Recognises the five macro spellings §6.4.13 treats alike. */
function isFileMacro(element: Element): boolean {
  if (tagOf(element) !== 'ac:structured-macro') return false;
  return FILE_MACROS.has(acAttr(element, 'name') ?? '');
}

/**
 * The element that shows a document-preview macro, or `null` when it names no file.
 *
 * A link where the file is on disk, and the bare name where it is not. Naming no file
 * at all is different from naming a missing one — there is nothing to say, so the table
 * stays preserved and the macro keeps its widget.
 */
function fileElement(element: Element, ctx: ConversionContext): Element | null {
  const filename = fileTarget(element);
  if (filename === null) return null;

  const document = element.ownerDocument;
  const path = ctx.resolveAttachment?.(filename) ?? null;

  if (path === null || path.length === 0) {
    const named = document.createElement('span');
    named.setAttribute('class', NAME_CLASS);
    named.appendChild(document.createTextNode(filename));
    return named;
  }

  const anchor = document.createElement('a');
  anchor.setAttribute('href', attachmentUrl(path));
  anchor.appendChild(document.createTextNode(filename));
  return anchor;
}

/**
 * The class that marks a stood-in name as ours (§6.4.14's device).
 *
 * A table may hold a `<span>` its author wrote. §6.4.6 unwraps a *bare* one, so in
 * practice only this pass writes them — but resting the reverse pattern on another
 * pass's behaviour is how a rule breaks silently when that pass changes.
 */
const NAME_CLASS = 'cf-file';

/**
 * The stood-in name, for the pattern that reads it back (§6.4.10's `PROJECTED`).
 *
 * The link form needs no entry of its own: it is an `<a>`, which that pattern already
 * matches. The body is `[^<]*` rather than `.*?` for the same reason it is there — a
 * file name, escaped on the way in, and a dot-matching form could span two of them
 * and take the cell between them with it.
 */
export const PROJECTED_TABLE_FILE = `<span class="${NAME_CLASS}">[^<]*</span>`;

/**
 * Replaces every document-preview macro in a *copy* of a table with the element that
 * shows it, so the table stops counting as namespaced markup.
 *
 * Mutates. Planned in full before anything is allocated, because `preserveBeside` takes
 * the next fragment id as a side effect — the trap §6.4.10 records.
 */
export function hideTableFilesIn(clone: Element, ctx: ConversionContext): boolean {
  const planned: { readonly macro: Element; readonly shown: Element }[] = [];

  for (const element of Array.from(clone.getElementsByTagName('ac:structured-macro'))) {
    if (!isFileMacro(element)) continue;
    if (element.parentNode === null) return false;

    const shown = fileElement(element, ctx);
    if (shown === null) return false;

    planned.push({ macro: element, shown });
  }

  const document = clone.ownerDocument;
  for (const { macro, shown } of planned) {
    const id = preserveBeside(ctx.placeholders, macro, {
      type: 'macro',
      label: 'shown inside a preserved table',
    });

    const parent = macro.parentNode as Node;
    parent.insertBefore(shown, macro);
    parent.insertBefore(document.createComment(`cf-tbl:${id}`), macro);
    parent.removeChild(macro);
  }
  return true;
}
