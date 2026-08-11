import { BLOCK_FENCE_LANGUAGE, readInlinePlaceholderId } from '../convert/placeholder-registry';
import { CONFLUENCE_KEY } from '../vault/frontmatter';
import { asNonEmptyString, isRecord, readPath } from '../util/guards';

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

export interface PlaceholderRendererDeps {
  /** Registers the code-block processor; `Plugin.registerMarkdownCodeBlockProcessor`. */
  readonly register: (
    language: string,
    handler: (source: string, element: HTMLElement, sourcePath: string) => void,
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
export function renderInlinePlaceholder(code: HTMLElement, id: string, label: string | null): void {
  // Plain DOM rather than Obsidian's `createSpan`, so the same code runs under the
  // test DOM. `textContent` never parses markup, which is the §7.4 rule that
  // matters here: a page body is untrusted input.
  const pill = code.ownerDocument.createElement('span');
  pill.className = 'confluence-inline-placeholder';
  pill.textContent = label === null || label.length === 0 ? 'Confluence content' : label;
  // The id stays reachable on hover: it is what a bug report needs, and what ties
  // the pill to its entry in the fragment cache.
  pill.setAttribute('title', `Preserved Confluence content (${id}). Edit it in Confluence.`);

  code.replaceWith(pill);
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
): void {
  const fields = parsePlaceholderFields(source);
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
  deps.register(BLOCK_FENCE_LANGUAGE, (source, element, sourcePath) => {
    renderPlaceholder(element, source, deps.pageUrlFor(sourcePath), deps.openExternal);
  });

  deps.registerInline((element, sourcePath) =>
    decorateInlinePlaceholders(element, sourcePath, deps.labelsFor),
  );
}
