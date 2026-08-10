/**
 * Conversion types (spec §6.4).
 *
 * Types only — no runtime code.
 */

import type { PhrasingContent, RootContent } from 'mdast';
import type { PlaceholderRegistry } from './placeholder-registry';

/** Context a conversion needs in both directions. */
export interface ConversionOptions {
  /** Absolute site URL, for rendering and recognising internal Confluence links. */
  readonly baseUrl: string;
  /** Space of the page being converted, for links that omit `ri:space-key`. */
  readonly spaceKey: string;
}

/** How a placeholder appears in the Markdown. */
export type FragmentKind = 'block' | 'inline';

/**
 * A preserved storage-format construct that Markdown cannot express.
 *
 * The `xhtml` is re-injected verbatim on push (spec FR-4.2), which is what makes
 * preserve-and-reinflate safe: the plugin never has to reconstruct something it
 * did not fully understand.
 */
export interface Fragment {
  readonly id: string;
  readonly kind: FragmentKind;
  /** Verbatim storage-format source. Never parsed for meaning, never rewritten. */
  readonly xhtml: string;
  /** Construct category, e.g. `macro`, `layout`, `user`, `unsupported`. */
  readonly type: string;
  /** Macro name where applicable, e.g. `jira`. */
  readonly name: string | null;
  /** Short human-readable summary shown in the rendered widget. */
  readonly label: string;
}

export type FragmentMap = ReadonlyMap<string, Fragment>;

export interface StorageToMarkdown {
  readonly markdown: string;
  readonly fragments: FragmentMap;
}

/**
 * Threaded through storage-to-Markdown conversion so the block, inline, table
 * and macro modules can call back into one another without importing each other
 * — a macro body contains blocks, and a block can contain a macro, which would
 * otherwise be a circular import.
 */
export interface ConversionContext extends ConversionOptions {
  readonly placeholders: PlaceholderRegistry;
  convertBlocks(nodes: readonly Node[]): RootContent[];
  convertPhrasing(nodes: readonly Node[]): PhrasingContent[];
}

/**
 * State threaded through Markdown-to-storage conversion.
 *
 * Failures are collected rather than thrown so the caller can report every
 * problem at once instead of only the first — a user who broke three
 * placeholders should be told about all three.
 */
export interface ReverseContext extends ConversionOptions {
  readonly fragments: FragmentMap;
  /**
   * The Markdown being converted.
   *
   * Needed because mdast discards escapes: `\[!info]` and `[!info]` parse to the
   * same text node, yet the first is literal text and the second is a callout.
   * Only the source can tell them apart.
   */
  readonly source: string;
  /** Placeholder ids referenced by the note but absent from the fragment cache. */
  readonly missingFragments: Set<string>;
  /** Constructs the note contains that cannot be expressed in storage format. */
  readonly unsupported: Set<string>;

  blocks(nodes: readonly RootContent[]): string;
  phrasing(nodes: readonly PhrasingContent[]): string;
}
