import type { PhrasingContent, RootContent } from 'mdast';
import { makeBlockPlaceholder, makeInlinePlaceholder, preserveBeside } from './placeholder-factory';
import { carriedBlock, carriedImage } from './placeholder-registry';
import { acAttr, childrenOf, riAttr, tagOf } from './storage-parser';
import type { ConversionContext } from './types';
import { formatEmbed, isLinkable } from './wikilink';

/**
 * Diagram macros, shown as the diagram (spec §6.4.8, D17, FR-4.13).
 *
 * A `drawio` macro holds no diagram — it holds a name. The diagram is an ordinary
 * page attachment, and the app keeps a rendered preview beside it, which is what
 * Confluence's own PDF and Word exports use. So the picture needs no rendering
 * here: it needs downloading, and then §6.4.7's device applied one level out —
 * the reader gets the picture, the macro's source rides along in the fragment
 * store, and push hands Confluence back the macro it sent.
 *
 * On the architecture pages of space EP this is the whole page: `Act signing
 * process` was three grey pills and nothing else.
 */

/** Macro names that stand for a diagram. `inc-drawio` embeds another page's. */
export const DIAGRAM_MACROS: ReadonlySet<string> = new Set(['drawio', 'inc-drawio']);

/** A macro's own parameter, by name — direct children only, never a nested macro's. */
function parameterValue(macro: Element, name: string): string {
  for (const child of childrenOf(macro)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (tagOf(element) !== 'ac:parameter' || acAttr(element, 'name') !== name) continue;
    return (element.textContent ?? '').trim();
  }
  return '';
}

/**
 * The attachment names a diagram might be stored under, best first.
 *
 * A guess, deliberately: the macro carries no `ri:filename`, so the only way to
 * find the file is to name candidates and let the real attachment listing decide
 * (FR-8.8). On the live instance the first rung hits — the preview is
 * `<diagramName>.png` — and the others cost nothing when they miss, because the
 * set they join is a filter over what the page actually has.
 */
export function diagramCandidates(diagramName: string): readonly string[] {
  const name = diagramName.trim();
  if (name.length === 0) return [];

  const rungs = (base: string): readonly string[] => [`${base}.png`, `${base}.drawio.png`, base];

  // The **untrimmed** name is asked for too, where it differs. A diagram name can carry
  // a trailing space — page 98074876's is `XRMV ` — and the app names the preview after
  // the name as given, so trimming first asks for a file that was never created and the
  // diagram stays a widget beside a preview that is right there. Trimmed first, because
  // it is the common case; the extra rungs cost nothing when they miss, for the reason
  // above.
  return name === diagramName ? rungs(name) : [...rungs(name), ...rungs(diagramName)];
}

/** The preview on disk, or `null` when none of the candidates came down. */
function previewPath(macro: Element, ctx: ConversionContext): string | null {
  for (const candidate of diagramCandidates(parameterValue(macro, 'diagramName'))) {
    const path = ctx.resolveAttachment?.(candidate) ?? null;
    if (path !== null && isLinkable(path)) return path;
  }
  return null;
}

/**
 * The diagram as a block: a paragraph holding the embed and the marker that
 * stands for the macro.
 *
 * The marker is `carriedBlock`, not `carriedImage`, because the macro was a child
 * of the body: the reverse pass has to replace this paragraph rather than fill it
 * in, or the `<p>` it would otherwise write appears in storage Confluence never
 * sent and the page stops being certified.
 */
export function convertDiagramBlock(
  macro: Element,
  name: string,
  ctx: ConversionContext,
): RootContent {
  const detail = { type: 'macro', name, label: macroLabel(macro, name) };
  const path = previewPath(macro, ctx);
  if (path === null) return makeBlockPlaceholder(ctx.placeholders, macro, detail);

  const carried = preserveBeside(ctx.placeholders, macro, detail, 'block');
  return {
    type: 'paragraph',
    children: [{ type: 'html', value: `${formatEmbed(path, null)}${carriedBlock(carried)}` }],
  };
}

/**
 * The diagram inline, where the macro sat inside a paragraph of Confluence's own.
 *
 * Here the `<p>` *is* Confluence's, so this is exactly the carried-image case and
 * needs no read-back of its own — only the marker that says so.
 */
export function convertDiagramInline(
  macro: Element,
  name: string,
  ctx: ConversionContext,
): PhrasingContent {
  const detail = { type: 'macro', name, label: macroLabel(macro, name) };
  const path = previewPath(macro, ctx);
  if (path === null) return makeInlinePlaceholder(ctx.placeholders, macro, detail);

  const carried = preserveBeside(ctx.placeholders, macro, detail, 'inline');
  return { type: 'html', value: `${formatEmbed(path, null)}${carriedImage(carried)}` };
}

/**
 * Which parameter names the thing a reader would recognise (spec FR-4.14).
 *
 * Ordered, because a macro can carry several: a diagram names its diagram, a Jira
 * macro its query, a page-tree macro its root.
 */
const IDENTIFYING = ['diagramName', 'name', 'title', 'filename', 'key', 'jqlQuery'];

/** The `ri:filename` of an attachment the macro points at — `view-file`'s subject. */
function attachedFilename(macro: Element): string | null {
  for (const descendant of Array.from(macro.getElementsByTagName('*'))) {
    if (tagOf(descendant) !== 'ri:attachment') continue;
    const filename = riAttr(descendant, 'filename');
    if (filename !== null && filename.length > 0) return filename;
  }
  return null;
}

/** True when the macro wraps content, rather than being nothing but parameters. */
function hasBody(macro: Element): boolean {
  return childrenOf(macro).some((child) => {
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = tagOf(child as Element);
    return tag === 'ac:rich-text-body' || tag === 'ac:plain-text-body';
  });
}

/**
 * A macro placeholder's label: what it is, and which one it is (spec FR-4.14).
 *
 * `textContent` is the wrong source for a macro whose body is nothing but
 * parameters — it concatenates their *values*, which is how `drawio macro —
 * trueCancelfalseautotoptrue5815` and 233 files labelled `view-file macro — 250`
 * reached readers of the EP mirror. Where a macro has a body, its text is real
 * content and still the most useful thing to show; where it has none, the macro's
 * own name is more honest than parameter soup.
 */
export function macroLabel(macro: Element, name: string): string {
  const what = name.length > 0 ? `${name} macro` : 'macro';

  for (const parameter of IDENTIFYING) {
    const value = parameterValue(macro, parameter);
    if (value.length > 0) return `${what} — ${value}`;
  }

  const filename = attachedFilename(macro);
  if (filename !== null) return `${what} — ${filename}`;

  const text = hasBody(macro) ? (macro.textContent ?? '').trim() : '';
  return text.length > 0 ? `${what} — ${text}` : what;
}
