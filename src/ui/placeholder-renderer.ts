import { BLOCK_FENCE_LANGUAGE, readInlinePlaceholderId } from '../convert/placeholder-registry';
import { CONFLUENCE_KEY } from '../vault/frontmatter';
import { asNonEmptyString, isRecord, readPath } from '../util/guards';
import type { ChildPage } from './child-pages';

/**
 * Rendering preserved Confluence content (spec FR-4.5).
 *
 * A placeholder block is the source of a construct Markdown cannot express. In
 * Reading View it is shown as a labelled widget saying what it stands for, with
 * a link to the page in Confluence, rather than as a wall of raw XHTML the
 * reader has to decode.
 *
 * The fragment's own markup is *never* rendered: page bodies are untrusted
 * input and this is the plugin's XSS boundary (spec §7.4). Only text this
 * module produced reaches the DOM, through `setText` and `createEl`.
 */

/** The flat `key: value` fence body, parsed for display. */
export function parsePlaceholderFields(source: string): Map<string, string> {
  const fields = new Map<string, string>();

  for (const line of source.split('\n')) {
    const match = /^\s*([a-z]+):\s*(.*)$/.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined) fields.set(key, value.trim());
  }
  return fields;
}

/**
 * Human-readable name for a preserved construct.
 *
 * Shared by the block widget and the inline pill so a reader meets the same words
 * for the same thing in both places.
 */
export function describeConstruct(name: string | null, type: string): string {
  if (name !== null && name.length > 0) return `${name} macro`;
  if (type === 'unsupported') return 'Confluence content';
  return `Confluence ${type}`;
}

/** Human-readable name for the construct behind a placeholder. */
export function describePlaceholder(fields: ReadonlyMap<string, string>): string {
  return describeConstruct(fields.get('name') ?? null, fields.get('type') ?? 'content');
}

/** Minimal view of the frontmatter API the renderer needs. */
export interface FrontmatterSource {
  readonly frontmatter?: unknown;
}

/** The page URL from a note's own frontmatter, or `null` if it has none. */
export function pageUrlFromCache(cache: FrontmatterSource | null): string | null {
  if (cache === null || !isRecord(cache.frontmatter)) return null;
  return asNonEmptyString(readPath(cache.frontmatter, CONFLUENCE_KEY, 'url'));
}

/** A heading in the note being rendered, as Obsidian's metadata cache holds it. */
export interface NoteHeading {
  readonly level: number;
  /** Raw heading text — what an Obsidian heading link has to address. */
  readonly heading: string;
}

/**
 * The readable words in a heading, with its Markdown taken off.
 *
 * A contents list is a list of *titles*, and a mirrored heading is rarely plain:
 * a Confluence page bolds a section number and not its name (`**2.4.** E-portal…`),
 * pins an inline comment to a phrase (`` `{cf:cfb-0008}`2.2. … ``), or is nothing
 * but a picture (`<strong><br/>![[…png|1000]]</strong>`). Stripping only the
 * outer emphasis left all three in the list verbatim.
 *
 * Display only. The *link* still addresses the raw heading, which is what
 * Obsidian resolves a heading reference against.
 */
export function headingText(heading: string): string {
  return (
    heading
      // Preserved constructs first: a placeholder is a whole code span and its
      // id is not a word. Images likewise carry no text to show.
      .replace(/`\{cf:cfb-\d+\}`/g, '')
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // Links keep their visible text.
      .replace(/\[\[([^[\]|]*)\|([^[\]]*)\]\]/g, '$2')
      .replace(/\[\[([^[\]]*)\]\]/g, '$1')
      .replace(/\[([^[\]]*)\]\([^)]*\)/g, '$1')
      // Inline HTML is markup, and a `<br/>` is a space.
      .replace(/<[^>]*>/g, ' ')
      // Emphasis runs, and the backticks around ordinary inline code.
      .replace(/(\*\*|__|~~|==|`)/g, '')
      // A lone `*` is emphasis; a lone `_` may be inside a word, so it goes only
      // where a delimiter can be — `snake_case` survives, `_italic_` does not.
      .replace(/\*/g, '')
      .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * A real table of contents in place of the `toc` macro (spec FR-4.5).
 *
 * Confluence generates its contents list at render time from the page's own
 * headings, so there is nothing in the storage format to convert — which left 239
 * pages across the mirror opening with a labelled widget where their navigation
 * belonged. Obsidian has the same information in its metadata cache, so the list
 * can simply be built here.
 *
 * The macro's parameters are not read. `maxLevel` and the rest change which
 * headings appear, and a contents list that quietly omits a section is worse than
 * one that shows all of them; the macro's source is preserved either way, so
 * Confluence keeps its own rendering untouched.
 *
 * `false` when the note has no headings — the cache may not have caught up, and a
 * heading-less contents list should fall back to saying what it stands for.
 */
export function renderTableOfContents(
  parent: HTMLElement,
  headings: readonly NoteHeading[],
): boolean {
  const entries = headings
    .map((entry) => ({ level: entry.level, raw: entry.heading, text: headingText(entry.heading) }))
    // A heading that is only a picture has no title to list. Confluence's own
    // contents list shows a blank line for it; an omission reads better.
    .filter((entry) => entry.text.length > 0);
  if (entries.length === 0) return false;

  const list = parent.createEl('ul', { cls: 'confluence-toc' });
  for (const entry of entries) {
    const item = list.createEl('li', {
      cls: `confluence-toc-item confluence-toc-level-${String(Math.min(entry.level, 6))}`,
    });
    // `data-href` is what Obsidian's own link handling reads; the class is what
    // styles it as a link. Text only — a heading is page content, so it goes in
    // through `text` and never as markup (§7.4).
    const link = item.createEl('a', { cls: 'internal-link', text: entry.text });
    link.setAttribute('href', `#${entry.raw}`);
    link.setAttribute('data-href', `#${entry.raw}`);
  }
  return true;
}

/**
 * A real child-page list in place of the `children` macro (spec §6.4.11, D20).
 *
 * The sibling of `renderTableOfContents`, and for the same reason: the macro holds
 * nothing to convert, because Confluence builds the list at render time from the
 * page tree — which the vault mirrors. 57 pages across the mirror opened with a grey
 * widget while their child notes sat in the same folder; `Backend Xəta Kodları` is
 * one, and the macro is that page's entire body.
 *
 * `false` when there is nothing to list, so the caller falls back to the widget — a
 * page with no children, or a macro refused for carrying a parameter that may point
 * the list at a different page (`listsOwnChildren`).
 */
export function renderChildPages(parent: HTMLElement, children: readonly ChildPage[]): boolean {
  if (children.length === 0) return false;

  const list = parent.createEl('ul', { cls: 'confluence-children' });
  for (const child of children) {
    const item = list.createEl('li', { cls: 'confluence-children-item' });
    // Same shape as the contents list above: `data-href` is what Obsidian's link
    // handling reads, the class is what styles it. The extension comes off because
    // that is the form Obsidian resolves and the form a user would have typed.
    const link = item.createEl('a', { cls: 'internal-link', text: child.title });
    const href = child.path.replace(/\.md$/, '');
    link.setAttribute('href', href);
    link.setAttribute('data-href', href);
  }
  return true;
}

export interface PlaceholderRendererDeps {
  /** Registers the code-block processor; `Plugin.registerMarkdownCodeBlockProcessor`. */
  readonly register: (
    language: string,
    handler: (source: string, element: HTMLElement, sourcePath: string) => void | Promise<void>,
  ) => void;
  /** Registers the inline processor; `Plugin.registerMarkdownPostProcessor`. */
  readonly registerInline: (
    handler: (element: HTMLElement, sourcePath: string) => Promise<void>,
  ) => void;
  /** The page URL recorded in the note's frontmatter, for "Open in Confluence". */
  readonly pageUrlFor: (sourcePath: string) => string | null;
  /**
   * What each preserved fragment in this note stands for, keyed by placeholder id.
   *
   * Read from the fragment cache rather than the note, because the note carries
   * only the sentinel — the whole point of a placeholder is that its source lives
   * outside the Markdown.
   */
  readonly labelsFor: (sourcePath: string) => Promise<ReadonlyMap<string, string>>;
  /** The note's own headings, for the `toc` macro to list. */
  readonly headingsFor: (sourcePath: string) => readonly NoteHeading[];
  /**
   * The child pages one `children` macro stands for (§6.4.11), empty where the
   * vault cannot answer honestly.
   *
   * Per placeholder rather than per note, and asynchronous, because the decision
   * needs the fragment's own source: a macro carrying a parameter may point the
   * list at a different page, and the fence body does not say whether it does.
   */
  readonly childPagesFor: (
    sourcePath: string,
    placeholderId: string,
  ) => Promise<readonly ChildPage[]>;
  readonly openExternal: (url: string) => void;
}

/**
 * Replaces an inline sentinel with a compact pill (spec FR-4.5, §6.4.3 rule 3).
 *
 * A mirrored page must never show a reader `{cf:cfb-0012}`. Space EP's first pull
 * put 54 418 of those in front of one, and even after §6.4.6 removed the
 * invisible ones there are thousands left standing for real constructs — an
 * image, a Jira query, a user mention.
 *
 * Built with `createEl`/`setText` only: page bodies are untrusted input and this
 * is the plugin's XSS boundary (§7.4).
 */
export function inlinePlaceholderPill(
  doc: Document,
  id: string,
  label: string | null,
): HTMLElement {
  // Plain DOM rather than Obsidian's `createSpan`, so the same code runs under the
  // test DOM. `textContent` never parses markup, which is the §7.4 rule that
  // matters here: a page body is untrusted input.
  const pill = doc.createElement('span');
  pill.className = 'confluence-inline-placeholder';
  pill.textContent = label === null || label.length === 0 ? 'Confluence content' : label;
  // The id stays reachable on hover: it is what a bug report needs, and what ties
  // the pill to its entry in the fragment cache.
  pill.setAttribute('title', `Preserved Confluence content (${id}). Edit it in Confluence.`);
  return pill;
}

/**
 * Replaces a rendered `<code>` sentinel with its pill.
 *
 * The Reading View half of FR-4.5. Live Preview draws the *same* pill from the same
 * builder (`live-preview-placeholders.ts`), which is what D16 means by one sentinel
 * grammar and two renderers: a reader must not be able to tell which mode they are in
 * by looking at the placeholder.
 */
export function renderInlinePlaceholder(code: HTMLElement, id: string, label: string | null): void {
  code.replaceWith(inlinePlaceholderPill(code.ownerDocument, id, label));
}

/** Every inline sentinel in a rendered note, replaced with its pill. */
export async function decorateInlinePlaceholders(
  element: HTMLElement,
  sourcePath: string,
  labelsFor: (sourcePath: string) => Promise<ReadonlyMap<string, string>>,
): Promise<void> {
  const codes = Array.from(element.querySelectorAll('code'));
  const pending = codes.flatMap((code) => {
    const id = readInlinePlaceholderId(code.textContent ?? '');
    return id === null ? [] : [{ code, id }];
  });
  if (pending.length === 0) return;

  const labels = await labelsFor(sourcePath);
  for (const { code, id } of pending) {
    renderInlinePlaceholder(code, id, labels.get(id) ?? null);
  }
}

export function renderPlaceholder(
  element: HTMLElement,
  source: string,
  url: string | null,
  openExternal: (url: string) => void,
  headings: readonly NoteHeading[] = [],
  childPages: readonly ChildPage[] = [],
): void {
  const fields = parsePlaceholderFields(source);

  // Two preserved constructs Obsidian can rebuild from scratch, because neither was
  // content in the first place: Confluence generates a contents list from the page's
  // headings and a child list from the page tree, and the vault holds both (§6.4.11).
  if (fields.get('name') === 'toc' && renderTableOfContents(element, headings)) return;
  if (fields.get('name') === 'children' && renderChildPages(element, childPages)) return;

  const widget = element.createDiv({ cls: 'confluence-placeholder' });

  widget.createDiv({ cls: 'confluence-placeholder-title', text: describePlaceholder(fields) });

  const label = fields.get('label');
  if (label !== undefined && label.length > 0) {
    widget.createDiv({ cls: 'confluence-placeholder-label', text: label });
  }

  widget.createDiv({
    cls: 'confluence-placeholder-note',
    text: 'Preserved exactly as Confluence stores it. Edit it there, then sync.',
  });

  if (url === null) return;

  const button = widget.createEl('button', {
    cls: 'confluence-placeholder-open',
    text: 'Open in Confluence',
  });
  button.addEventListener('click', () => {
    openExternal(url);
  });
}

export function registerPlaceholderRenderer(deps: PlaceholderRendererDeps): void {
  deps.register(BLOCK_FENCE_LANGUAGE, async (source, element, sourcePath) => {
    const fields = parsePlaceholderFields(source);
    // Only a `children` macro waits on the fragment sidecar. Every other widget —
    // and there are 201 pages of `view-file` alone — must still render without a
    // file read it has no use for.
    const childPages =
      fields.get('name') === 'children'
        ? await deps.childPagesFor(sourcePath, fields.get('id') ?? '')
        : [];

    renderPlaceholder(
      element,
      source,
      deps.pageUrlFor(sourcePath),
      deps.openExternal,
      deps.headingsFor(sourcePath),
      childPages,
    );
  });

  deps.registerInline((element, sourcePath) =>
    decorateInlinePlaceholders(element, sourcePath, deps.labelsFor),
  );
}
