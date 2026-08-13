import { childrenOf, tagOf } from './storage-parser';

/**
 * Canonicalising forms that render identically (spec §6.4.5, §6.4.6).
 *
 * The companion to `discard.ts`: that module removes markup Confluence renders as
 * nothing, this one rewrites markup it renders the *same way* into one chosen
 * form. Both run on the way into conversion and on the way into normalisation, so
 * each rule applies to both sides of every fidelity comparison — which is what
 * lets a form be changed without costing a page its `certified` status.
 *
 * Every rule here was found the same way: a page went read-only because
 * Confluence writes a construct two ways and Markdown has only one, so whichever
 * form the reverse pass did not happen to produce could never be reproduced.
 *
 * Pure DOM surgery, no I/O (FR-4.8).
 */

/** Whether a node is whitespace-only text, which never counts as content. */
export function isBlankText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim().length === 0;
}

function isBreak(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && tagOf(node as Element) === 'br';
}

/** Significant content: anything but whitespace-only text. */
export function hasContent(element: Element): boolean {
  return childrenOf(element).some((child) => !isBlankText(child));
}

/** Elements whose leading and trailing whitespace is invisible in a rendered page. */
const TEXT_BLOCKS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
  'ac:rich-text-body',
]);

/** Row containers a table may use, all of which render the same way. */
const ROW_SECTIONS = new Set(['thead', 'tbody', 'tfoot']);

/**
 * Puts every row of a table into a single `<tbody>`.
 *
 * `<thead>`, `<tfoot>` and rows sitting directly under `<table>` all render
 * identically to `<tbody>` in Confluence, which takes its header styling from
 * `<th>` rather than from the section. The reverse pass has only one form to
 * write — `<table><tbody>…` — so without this the *structure* differs after a
 * round trip and the page becomes read-only over markup nobody can see.
 */
function canonicaliseTableSections(table: Element): void {
  const rows: Element[] = [];
  const sections: Element[] = [];
  let looseRows = 0;

  for (const child of childrenOf(table)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = tagOf(element);

    if (tag === 'tr') {
      looseRows += 1;
      rows.push(element);
      continue;
    }
    if (!ROW_SECTIONS.has(tag)) continue;

    sections.push(element);
    for (const row of childrenOf(element)) {
      if (row.nodeType === Node.ELEMENT_NODE && tagOf(row as Element) === 'tr') {
        rows.push(row as Element);
      }
    }
  }

  // One `<tbody>` and nothing loose is already the target form, and a table with
  // no rows has nothing to move. Between them that is the overwhelming majority
  // of real tables, and leaving them untouched keeps this a no-op for them.
  const canonical =
    looseRows === 0 && sections.length === 1 && tagOf(sections[0] as Element) === 'tbody';
  if (rows.length === 0 || canonical) return;

  const tbody = table.ownerDocument.createElement('tbody');
  for (const row of rows) tbody.appendChild(row);
  for (const section of sections) section.parentNode?.removeChild(section);
  table.appendChild(tbody);
}

/** Replaces an element with its own children. */
export function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (parent === null) return;

  while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * Trims the whitespace at the very start and end of a text block.
 *
 * Invisible in a rendered page, but `remark-stringify` has to encode a
 * significant edge space as `&#x20;` to keep it, and a spec page reads badly
 * with `TAXAZ-210-00&#x20;` in it. 26 such entities landed in one EP page alone.
 */
function trimEdgeWhitespace(element: Element): void {
  // `\s` rather than a literal space, so a no-break space counts. Confluence's
  // editor ends paragraphs with `&nbsp;` constantly, and a trailing one is as
  // invisible as a trailing space — but it is *not* a space, so a narrower
  // pattern trimmed it on the second pass and not the first, which cost the
  // converter its idempotence.
  const first = element.firstChild;
  if (first !== null && first.nodeType === Node.TEXT_NODE) {
    first.nodeValue = (first.nodeValue ?? '').replace(/^\s+/, '');
  }

  const last = element.lastChild;
  if (last !== null && last.nodeType === Node.TEXT_NODE) {
    last.nodeValue = (last.nodeValue ?? '').replace(/\s+$/, '');
  }
}

/**
 * Blocks that can sit inside a list item alongside its text.
 *
 * Used to tell "this item is a paragraph" from "this item is a paragraph *and*
 * something else", which is the distinction the whole `<p>`-wrapper question
 * turns on.
 */
const ITEM_BLOCKS = new Set([
  'p',
  'ul',
  'ol',
  'table',
  'div',
  'blockquote',
  'pre',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ac:structured-macro',
  'ac:task-list',
  'ac:layout',
]);

/**
 * Containers whose direct children the converter treats as a mix of blocks and
 * loose inline content, gathering each inline run into a paragraph.
 *
 * `storage-root` is the body itself; the other two are the places a macro or a
 * quote holds arbitrary content. Anywhere on this list, an unwrapped inline run
 * comes back wrapped, so it has to be wrapped before the comparison too.
 */
const LOOSE_INLINE_HOSTS = new Set(['storage-root', 'ac:rich-text-body', 'blockquote']);

/**
 * Wraps a list item's loose text in `<p>` when the item also holds a block.
 *
 * Confluence writes both `<li>Step<ul>…</ul></li>` and
 * `<li><p>Step</p><ul>…</ul></li>` — its editor produces the second, its older
 * imports the first, and space EP has both. Markdown has only one form for them,
 * so one of the two could never be reproduced: whichever one the reverse pass did
 * not happen to write went read-only, and *every* numbered step with sub-steps in
 * a specification page is one of these.
 *
 * Canonicalising on the wrapped form settles it, in the direction Confluence's own
 * editor already writes.
 */
function wrapLooseItemContent(item: Element, always = false): void {
  const children = childrenOf(item);
  const hasBlock = children.some(
    (child) => child.nodeType === Node.ELEMENT_NODE && ITEM_BLOCKS.has(tagOf(child as Element)),
  );
  if (!hasBlock && !always) return;

  let run: Node[] = [];
  const flush = (before: Node | null): void => {
    if (run.length === 0) return;

    const paragraph = item.ownerDocument.createElement('p');
    for (const node of run) paragraph.appendChild(node);
    item.insertBefore(paragraph, before);
    // The full treatment, because the walk has already passed this position and
    // this paragraph will never get a visit of its own. Giving it only *part* of
    // the treatment is what left a space after a `<br/>` inside it, which
    // Markdown then had to write as a line-initial `&#x20;`.
    tidyWhitespace(paragraph);
    run = [];
  };

  for (const child of children) {
    const isBlock =
      child.nodeType === Node.ELEMENT_NODE && ITEM_BLOCKS.has(tagOf(child as Element));
    if (isBlock) {
      flush(child);
      continue;
    }
    // Whitespace between two blocks is layout, not content, and wrapping it would
    // invent an empty paragraph.
    if (isBlankText(child) && run.length === 0) continue;
    run.push(child);
  }
  flush(null);
}

/**
 * Removes the line breaks at the very start and end of a text block.
 *
 * `<p>User: The Ministry of Taxes<br/></p>` renders exactly like the same
 * paragraph without the break: the paragraph already ends there. Markdown then
 * has to write that break as a raw `<br/>` or a dangling `\`, and space EP
 * arrived with 11 477 of the former and 1 039 of the latter — a visible blank
 * line the author never put there.
 */
function trimEdgeBreaks(element: Element): void {
  const drop = (next: () => Node | null): void => {
    for (;;) {
      const node = next();
      if (node === null) return;
      if (isBlankText(node) || isBreak(node)) element.removeChild(node);
      else return;
    }
  };

  drop(() => element.lastChild);
  drop(() => element.firstChild);
}

/**
 * Removes the whitespace on either side of a line break.
 *
 * HTML collapses it away, so `one<br/> two` and `one<br/>two` render identically —
 * but Markdown cannot hold a space at the start of a line, so `remark-stringify`
 * has to write it as `&#x20;`. Space EP arrived with 11 445 of those, most of them
 * the first thing on a line: `&#x20;TAXAZ-000-01`.
 */
function trimAroundBreaks(element: Element): void {
  for (const child of childrenOf(element)) {
    if (!isBreak(child)) continue;

    const before = child.previousSibling;
    if (before !== null && before.nodeType === Node.TEXT_NODE) {
      before.nodeValue = (before.nodeValue ?? '').replace(/\s+$/, '');
    }
    const after = child.nextSibling;
    if (after !== null && after.nodeType === Node.TEXT_NODE) {
      after.nodeValue = (after.nodeValue ?? '').replace(/^\s+/, '');
    }
  }
}

/**
 * Inline formatting whose edge whitespace is invisible.
 *
 * Bold and italic change glyphs and nothing else, so a space inside the element
 * and the same space outside it are indistinguishable. Deliberately excludes
 * `<u>`, `<s>` and anything with a background: those *draw* over the space, so
 * moving it would be a visible change.
 */
const GLYPH_EMPHASIS = new Set(['strong', 'b', 'em', 'i']);

/**
 * Moves whitespace out of bold and italic.
 *
 * `<strong>1.1. </strong>` forces Markdown to write `**1.1.&#x20;**`, because a
 * space just inside the delimiters would otherwise be dropped. Lifted out, it is
 * an ordinary space between two words.
 */
function liftEdgeWhitespace(element: Element): void {
  if (!GLYPH_EMPHASIS.has(tagOf(element))) return;
  const parent = element.parentNode;
  if (parent === null) return;

  const first = element.firstChild;
  if (first !== null && first.nodeType === Node.TEXT_NODE) {
    const leading = /^\s+/.exec(first.nodeValue ?? '')?.[0];
    if (leading !== undefined) {
      first.nodeValue = (first.nodeValue ?? '').slice(leading.length);
      parent.insertBefore(element.ownerDocument.createTextNode(leading), element);
    }
  }

  const last = element.lastChild;
  if (last !== null && last.nodeType === Node.TEXT_NODE) {
    const trailing = /\s+$/.exec(last.nodeValue ?? '')?.[0];
    if (trailing !== undefined) {
      last.nodeValue = (last.nodeValue ?? '').replace(/\s+$/, '');
      parent.insertBefore(element.ownerDocument.createTextNode(trailing), element.nextSibling);
    }
  }

  // Emphasis with nothing left to emphasise is not emphasis at all.
  if (!hasContent(element)) unwrap(element);
}

/**
 * Constructs that render their own thing, with no glyphs for emphasis to change.
 *
 * A picture is the same pixels bold or not, and a macro draws whatever it draws —
 * a table of contents, a diagram, an attached file — regardless of the `<strong>`
 * around it.
 */
const OPAQUE_TO_EMPHASIS = new Set(['ac:image', 'ac:structured-macro']);

/**
 * Removes bold or italic that wraps nothing an emphasis could affect.
 *
 * Confluence's editor writes it whenever an author selects a line holding a
 * picture or a macro and presses Ctrl+B, and it is not free to leave: Markdown
 * emphasis needs a word to attach to, so `wrap` in `storage-phrasing.ts`
 * preserves a wordless one whole — taking whatever is inside it along.
 *
 * Across the mirror that hid 216 images, every one with its file already
 * downloaded and sitting unreferenced in `_attachments`, and 41 tables of
 * contents, behind a label reading "strong without word content". What it must
 * *not* touch is wordless bold that really is text — `<strong>№</strong>`,
 * `<strong>.</strong>` — which Markdown genuinely cannot write and which
 * outnumbers both.
 */
function unwrapEmptyEmphasis(element: Element): void {
  if (!GLYPH_EMPHASIS.has(tagOf(element))) return;

  const significant = childrenOf(element).filter((child) => !isBlankText(child));
  if (significant.length === 0) return;

  const opaqueOnly = significant.every(
    (child) =>
      child.nodeType === Node.ELEMENT_NODE && OPAQUE_TO_EMPHASIS.has(tagOf(child as Element)),
  );
  if (opaqueOnly) unwrap(element);
}

/**
 * Tags that are two spellings of one rendering.
 *
 * Confluence's editor emits both, sometimes side by side in one sentence, and
 * Markdown has a single form for each pair — so `<strong>a</strong><b>b</b>`
 * became `**a**`, a zero-width separator, then `**b**`, which is what put
 * `**&#x200B;**` in the middle of a heading.
 */
const TAG_ALIASES = new Map([
  ['b', 'strong'],
  ['i', 'em'],
  ['strike', 's'],
  ['del', 's'],
]);

/** The tag a pair of aliases both stand for. */
function canonicalTag(element: Element): string {
  const tag = tagOf(element);
  return TAG_ALIASES.get(tag) ?? tag;
}

/** Inline formatting that can absorb an identical neighbour without any visible change. */
const MERGEABLE = new Set([
  'strong',
  'b',
  'em',
  'i',
  's',
  'del',
  'strike',
  'u',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'span',
  'font',
]);

/** Attributes as a comparable string, so two elements can be checked for sameness. */
function signature(element: Element): string {
  return Array.from(element.attributes)
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort()
    .join('\u0000');
}

/**
 * Merges neighbouring inline elements that are the same element twice.
 *
 * `<strong>a</strong><strong>b</strong>` renders exactly like `<strong>ab</strong>`,
 * and Confluence's editor produces the split form whenever text was typed in two
 * goes. Markdown cannot express it — `**a****b**` reads as one run — so the
 * converter had to separate the two with a zero-width space, which
 * `remark-stringify` then wrote out as `&#x200B;`: 1 097 of them in EP, right in
 * the middle of headings.
 */
function mergeAdjacentInline(parent: Element): void {
  let previous: Element | null = null;

  for (const child of childrenOf(parent)) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      // *Any* text ends the run, whitespace included. A space between two bold
      // runs is the space between two words, and merging across it deleted it:
      // `<strong>kabineti</strong> <strong>göndərilən</strong>` came out as
      // `**kabinetigöndərilən**`. Worse, the two sides of the fidelity comparison
      // lost it alike, so the page still certified while its text was wrong.
      // Markdown needs no help here — `**a** **b**` is two runs already.
      previous = null;
      continue;
    }

    const element = child as Element;
    const tag = tagOf(element);
    if (!MERGEABLE.has(tag)) {
      previous = null;
      continue;
    }

    // Compared by canonical tag, so `<strong>` absorbs an adjacent `<b>`: they
    // render the same and Markdown writes them the same, so a separator between
    // them is noise the reader has to look past.
    if (
      previous !== null &&
      canonicalTag(previous) === canonicalTag(element) &&
      signature(previous) === signature(element)
    ) {
      while (element.firstChild !== null) previous.appendChild(element.firstChild);
      parent.removeChild(element);
      continue;
    }
    previous = element;
  }
}

/**
 * Every whitespace rule a text block needs, in one place.
 *
 * Extracted because a paragraph this module *creates* never gets its own visit
 * from the walk — the walk has already passed that position — so it has to be
 * given the same treatment by hand. Doing that piecemeal is how a leading space
 * after a `<br/>` survived into 42 notes as `&#x20;`, every one of them
 * read-only. Anything that builds a text block calls this, not a subset of it.
 */
function tidyWhitespace(element: Element): void {
  // Twice around the edges: removing a break can expose the whitespace that sat
  // in front of it.
  trimAroundBreaks(element);
  trimEdgeWhitespace(element);
  trimEdgeBreaks(element);
  trimEdgeWhitespace(element);
}

/**
 * Removes the paragraph around a macro that stands on its own.
 *
 * Confluence writes both `<ac:structured-macro/>` and `<p><ac:structured-macro/></p>`
 * for a macro occupying a whole line, and renders them the same way — but the
 * converter reads only the first as a block. In a paragraph the macro goes down
 * the inline path instead and comes out as `{cf:…}` mid-line, carrying no name,
 * so nothing downstream can tell a table of contents from a Jira query.
 *
 * Restricted to the page body: a paragraph inside a list item or a cell is
 * load-bearing for those, and this is about macros that already occupy a line.
 */
function unwrapParagraphAroundMacro(element: Element): void {
  if (tagOf(element) !== 'p') return;

  const parent = element.parentNode;
  if (parent === null || parent.nodeType !== Node.ELEMENT_NODE) return;
  if (tagOf(parent as Element) !== 'storage-root') return;

  const significant = childrenOf(element).filter((child) => !isBlankText(child));
  const only = significant.length === 1 ? significant[0] : undefined;
  if (only === undefined || only.nodeType !== Node.ELEMENT_NODE) return;
  if (tagOf(only as Element) !== 'ac:structured-macro') return;

  unwrap(element);
}

/**
 * Puts an anchor link's text into the one body form, and trims it (§6.4.15).
 *
 * Confluence writes an anchor link's text two ways — `<ac:link-body>` and
 * `<ac:plain-text-link-body>` — and renders them identically when the body holds
 * nothing but text. The mirror has 2 126 of the first and 1 403 of the second, so
 * whichever form the reverse pass wrote, the other could never be reproduced and
 * every page holding one would be read-only. This chooses the plain-text form,
 * which is the one a Markdown link's text can carry back.
 *
 * The text is trimmed too. Confluence stores these with a trailing space
 * remarkably often — `<ac:link-body>1. History </ac:link-body>` — and a Markdown
 * link's text is not a reliable place to keep one. Inside a link the space is
 * invisible but for a hair of extra underline, which is the §6.4.5 bargain exactly.
 *
 * Scoped to anchor links. A *page* link's two body forms decide whether it can
 * become a wikilink at all (`plainLabel` returns `undefined` for the rich form), so
 * collapsing them there would change how page links render — a separate question
 * with its own evidence.
 */
function canonicaliseAnchorLinkBody(element: Element): void {
  if (tagOf(element) !== 'ac:link' || element.getAttribute('ac:anchor') === null) return;

  for (const child of childrenOf(element)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const body = child as Element;
    const tag = tagOf(body);
    if (tag !== 'ac:link-body' && tag !== 'ac:plain-text-link-body') continue;

    // A body carrying markup is left exactly as it is: it cannot become a Markdown
    // link's text, so it must stay a widget, and rewriting it would only make the
    // widget's fragment differ from what Confluence sent.
    if (childrenOf(body).some((node) => node.nodeType === Node.ELEMENT_NODE)) return;

    const text = (body.textContent ?? '').trim();
    const replacement = element.ownerDocument.createElement('ac:plain-text-link-body');
    replacement.appendChild(element.ownerDocument.createTextNode(text));
    element.replaceChild(replacement, body);
    return;
  }
}

/**
 * Every canonicalisation, in the order they depend on each other: structure
 * first, then whitespace, so a trim sees the elements it will actually be next to.
 */
export function canonicaliseForm(element: Element): void {
  const tag = tagOf(element);
  unwrapParagraphAroundMacro(element);
  canonicaliseAnchorLinkBody(element);
  if (tag === 'table') canonicaliseTableSections(element);
  if (tag === 'li') wrapLooseItemContent(element);

  // Loose inline content directly inside a body gains a `<p>` on the way to
  // Markdown, because a Markdown document has no way to hold a bare inline run —
  // `convertMixedContent` gathers one into a paragraph. So the reverse pass writes
  // a `<p>` the original may not have had, and the page cannot round-trip.
  //
  // `<ac:image>` alone in a body is the common case: 138 notes in space EP hold an
  // image embed and 109 of them were read-only for exactly this reason.
  if (LOOSE_INLINE_HOSTS.has(tag)) wrapLooseItemContent(element, true);

  liftEdgeWhitespace(element);
  unwrapEmptyEmphasis(element);
  mergeAdjacentInline(element);

  if (TEXT_BLOCKS.has(tag)) tidyWhitespace(element);
}
