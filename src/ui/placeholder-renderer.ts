import { BLOCK_FENCE_LANGUAGE } from '../convert/placeholder-registry';
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

/** Human-readable name for the construct behind a placeholder. */
export function describePlaceholder(fields: ReadonlyMap<string, string>): string {
  const name = fields.get('name');
  const type = fields.get('type') ?? 'content';

  if (name !== undefined && name.length > 0) return `${name} macro`;
  if (type === 'unsupported') return 'Confluence content';
  return `Confluence ${type}`;
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
  /** The page URL recorded in the note's frontmatter, for "Open in Confluence". */
  readonly pageUrlFor: (sourcePath: string) => string | null;
  readonly openExternal: (url: string) => void;
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
}
