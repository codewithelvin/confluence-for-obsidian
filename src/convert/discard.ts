import { canonicaliseForm, hasContent, unwrap } from './canonicalise';
import { childrenOf, hasNamespacedMarkup, tagOf } from './storage-parser';

/**
 * Removing markup Confluence renders as nothing (spec §6.4.6, decision D14).
 *
 * A pre-pass over the parsed body, applied before conversion *and* before
 * normalisation, which is what keeps it honest: the same markup disappears from
 * both sides of every fidelity comparison, so dropping it costs no page its
 * `certified` status (§6.4.5). The cost it does carry is that pushing a touched
 * page writes the cleaned markup back — decision D14 accepts that, and Strict
 * markup (FR-4.12) turns the whole pass off.
 *
 * Everything here earned its place from measurements on space EP, whose first
 * pull produced 54 418 inline placeholders. Roughly 45 000 of them stood for
 * markup with no rendered effect at all.
 *
 * Pure DOM surgery: no I/O, no allocation of ids, nothing that could differ
 * between two runs (FR-4.8).
 */

/**
 * Colours Confluence's editor writes for ordinary body text.
 *
 * `rgb(23,43,77)` is Atlassian's default text colour and `rgb(0,0,0)` plain
 * black; between them they account for 23 303 of the 42 101 coloured spans in
 * EP — text marked with the colour it already has. Any *other* colour is real
 * formatting and is kept.
 */
const DEFAULT_TEXT_COLOURS = new Set([
  'rgb(0,0,0)',
  '#000000',
  '#000',
  'black',
  'rgb(23,43,77)',
  '#172b4d',
]);

/**
 * Style properties that never change what a reader sees in Obsidian.
 *
 * `list-style-type` is here because Confluence marks nested wrapper items with
 * `list-style-type: none`, and that single declaration was enough to preserve a
 * whole list as an opaque block.
 */
const DISCARDABLE_PROPERTIES = new Set([
  'letter-spacing',
  'font-family',
  'line-height',
  'white-space',
  'list-style-type',
  'width',
  'height',
  'min-width',
  'max-width',
]);

/** Values that state the default and therefore state nothing. */
const DISCARDABLE_VALUES = new Map([
  ['text-align', new Set(['left', 'start', 'inherit', 'initial'])],
  ['text-decoration', new Set(['none', 'inherit', 'initial'])],
  ['font-weight', new Set(['normal', '400', 'inherit', 'initial'])],
  ['font-style', new Set(['normal', 'inherit', 'initial'])],
]);

/** A style declaration, as `property: value`. */
function keepDeclaration(declaration: string): boolean {
  const separator = declaration.indexOf(':');
  if (separator < 0) return true;

  const property = declaration.slice(0, separator).trim().toLowerCase();
  const value = declaration
    .slice(separator + 1)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  if (DISCARDABLE_PROPERTIES.has(property)) return false;
  if (property === 'color') return !DEFAULT_TEXT_COLOURS.has(value);
  return DISCARDABLE_VALUES.get(property)?.has(value) !== true;
}

/**
 * Strips discardable declarations from a `style` attribute, removing the
 * attribute entirely when nothing meaningful is left.
 */
function filterStyle(element: Element): void {
  const style = element.getAttribute('style');
  if (style === null) return;

  const kept = style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0 && keepDeclaration(declaration));

  if (kept.length === 0) element.removeAttribute('style');
  else element.setAttribute('style', kept.join('; '));
}

/**
 * Whether an element's `class` attribute can go.
 *
 * All of it can. Confluence's storage format carries semantics in `ac:`
 * elements and attributes; `class` is purely its own CSS — `auto-cursor-target`
 * on headings, `confluenceTable`/`confluenceTd` on every table and cell,
 * `atl-forced-newline` on editor line breaks. None of it means anything in a
 * vault, and the table classes alone were enough to make `analyseTable` reject
 * essentially every real table and preserve it as an opaque block instead.
 */
function dropClasses(element: Element): void {
  element.removeAttribute('class');
}

/**
 * Attributes Confluence's editor leaves behind. None of them render, and each
 * one is enough to make a table opaque: `analyseTable` refuses any cell carrying
 * an attribute, because a GFM cell has nowhere to put one.
 *
 * Counted across space EP: 1 843 `data-highlight-colour`, 846 `title`, 120
 * `contenteditable`, 120 `data-mce-resize`, 57 `scope`.
 */
const EDITOR_ATTRIBUTES = new Set(['contenteditable', 'data-highlight-colour', 'scope']);

/** Elements whose `title` is Confluence's own highlight tooltip rather than content. */
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);

function dropEditorAttributes(element: Element): void {
  const tag = tagOf(element);

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const isArtefact =
      EDITOR_ATTRIBUTES.has(name) ||
      name.startsWith('data-mce-') ||
      name.startsWith('data-snooker-') ||
      // `title` carries a real tooltip on a link, but on a cell it is the text
      // Confluence generates for its own highlight colour — "Background colour :
      // Grey" — describing a colour that this pass has already removed.
      (name === 'title' && TABLE_PARTS.has(tag));

    if (isArtefact) element.removeAttribute(attribute.name);
  }
}

/** Blocks whose only way to carry presentation into a note is raw HTML. */
const STYLEABLE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div']);

/**
 * Drops presentation from a block that wraps namespaced markup.
 *
 * A styled block has to be written into the note as raw HTML, since Markdown has
 * nowhere to put `text-align: right` — and writing it out means writing out its
 * children too, which FR-4.9 forbids when any of them is `ac:`- or
 * `ri:`-namespaced. The alignment is the cheaper of the two losses: without this
 * the choice is between a heading that renders as nothing and an opaque block
 * whose content the reader cannot see at all.
 *
 * Real case from space EP: `<h1 style="text-align: right;"><ac:image …/></h1>`
 * opened one of the largest specification pages.
 */
function dropStyleAroundNamespacedMarkup(element: Element): void {
  if (!STYLEABLE_BLOCKS.has(tagOf(element))) return;
  if (element.getAttribute('style') === null) return;
  if (!hasNamespacedMarkup(element)) return;

  element.removeAttribute('style');
}

/** Whether the element is an `anchor` macro: a link target with no visible output. */
function isAnchorMacro(element: Element): boolean {
  if (tagOf(element) !== 'ac:structured-macro') return false;
  return element.getAttribute('ac:name') === 'anchor';
}

/**
 * Whether the element is a wrapper with nothing left to wrap.
 *
 * Only ever true after this pass has already removed the attributes that were
 * the element's entire reason for existing.
 */
function isEmptyWrapper(element: Element): boolean {
  const tag = tagOf(element);
  if (tag !== 'span' && tag !== 'div' && tag !== 'font' && tag !== 'p') return false;
  if (element.attributes.length > 0) return false;
  return element.childNodes.length === 0;
}

/**
 * One depth-first pass. Children are visited before the element itself, so that
 * a span emptied by its children's removal is seen as empty on the way back up.
 */
function clean(node: Node): void {
  for (const child of childrenOf(node)) clean(child);
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;

  if (isAnchorMacro(element)) {
    element.parentNode?.removeChild(element);
    return;
  }

  // Column widths, and nothing else: a `<colgroup>` of percentages is why a
  // table with a perfectly ordinary grid could not be written as one.
  if (tagOf(element) === 'colgroup') {
    element.parentNode?.removeChild(element);
    return;
  }

  dropClasses(element);
  dropEditorAttributes(element);
  filterStyle(element);
  dropStyleAroundNamespacedMarkup(element);

  // Once the attributes are gone, the forms that render identically can be
  // settled on one of them (§6.4.5).
  canonicaliseForm(element);

  const tag = tagOf(element);

  // A paragraph of nothing but line breaks is how Confluence's editor makes
  // vertical space, and space EP contained 5 958 of them. Markdown puts a blank
  // line between blocks anyway, so each one was buying a second gap on top of the
  // one the note already had. A run of them collapses to that single blank line.
  if (tag === 'p' && !hasContent(element)) {
    element.parentNode?.removeChild(element);
    return;
  }

  if (isEmptyWrapper(element)) {
    element.parentNode?.removeChild(element);
    return;
  }
  // A span that carried only presentation is now indistinguishable from no span
  // at all, so it goes: this is the single biggest source of the tokens that
  // buried EP's prose.
  //
  // A `<div>` with nothing left on it is the same story one level up — and it
  // has to be removed *here* rather than only during conversion, or the two
  // sides of the fidelity comparison disagree about whether the div exists.
  if ((tag === 'span' || tag === 'div') && element.attributes.length === 0) unwrap(element);
}

/**
 * Removes every construct in §6.4.6 from a parsed body, in place.
 *
 * Called on the way into conversion and on the way into normalisation, never in
 * between — an asymmetric application would silently make pages read-only.
 */
export function discardInvisibleMarkup(root: Element): void {
  clean(root);
}
