/**
 * The note frontmatter contract (spec §6.5.1).
 *
 * `confluence` is a reserved key the plugin owns. Every other key belongs to the
 * user and must survive every write untouched (FR-4.6) — which is why writes go
 * through Obsidian's `processFrontMatter` rather than any YAML of our own, and
 * why the existing block is carried across verbatim when a note's body is
 * replaced.
 *
 * Pure module: string and object work only, no I/O.
 */

import { asFiniteNumber, asNonEmptyString, isRecord } from '../util/guards';

/** The reserved frontmatter key. Everything under it is plugin-owned. */
export const CONFLUENCE_KEY = 'confluence';

/**
 * Obsidian's own alias key, which the plugin *shares* rather than owns: it
 * maintains the single entry holding the page's true title (FR-4.11) and leaves
 * every other entry alone.
 */
export const ALIASES_KEY = 'aliases';

export type Fidelity = 'certified' | 'degraded';

/** Portable page identity, per spec §6.5.1. */
export interface ConfluenceIdentity {
  readonly id: string;
  readonly space: string;
  readonly version: number;
  readonly parent: string | null;
  readonly url: string;
  readonly updated: string;
  readonly updatedBy: string;
  readonly fidelity: Fidelity;
}

/** Canonical page URL. `viewpage.action` works regardless of the page's title. */
export function pageUrl(baseUrl: string, pageId: string): string {
  return `${baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * The value written under the `confluence` key.
 *
 * A plain object rather than the interface, because this is what goes into
 * Obsidian's frontmatter serialiser: `undefined` would be dropped silently, so
 * an absent parent is written as an explicit `null`.
 */
export function toFrontmatterValue(identity: ConfluenceIdentity): Record<string, unknown> {
  return {
    id: identity.id,
    space: identity.space,
    version: identity.version,
    parent: identity.parent,
    url: identity.url,
    updated: identity.updated,
    updatedBy: identity.updatedBy,
    fidelity: identity.fidelity,
  };
}

/**
 * Reads a page id, which YAML may hand back as a number.
 *
 * Confluence ids are digits, so a frontmatter block the user unquoted — or an
 * editor that helpfully "fixed" the quoting — arrives as a number. Refusing it
 * would orphan the note from the page it plainly identifies.
 */
function asPageId(value: unknown): string | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) return Number.isInteger(numeric) ? String(numeric) : null;
  return asNonEmptyString(value);
}

/**
 * Reads the identity back out of parsed frontmatter.
 *
 * This is how the state index is rebuilt if it is ever lost (§6.5.1), so it
 * treats the file as untrusted: a hand-edited or half-written block yields
 * `null` rather than a half-populated identity.
 */
export function readIdentity(frontmatter: unknown): ConfluenceIdentity | null {
  if (!isRecord(frontmatter)) return null;
  const raw = frontmatter[CONFLUENCE_KEY];
  if (!isRecord(raw)) return null;

  const id = asPageId(raw['id']);
  const space = asNonEmptyString(raw['space']);
  if (id === null || space === null) return null;

  return {
    id,
    space,
    version: asFiniteNumber(raw['version']) ?? 0,
    parent: asPageId(raw['parent']),
    url: asNonEmptyString(raw['url']) ?? '',
    updated: asNonEmptyString(raw['updated']) ?? '',
    updatedBy: asNonEmptyString(raw['updatedBy']) ?? '',
    fidelity: raw['fidelity'] === 'degraded' ? 'degraded' : 'certified',
  };
}

/**
 * Reads `aliases`, which Obsidian accepts as either a list or a bare string.
 *
 * Anything that is neither is treated as no aliases at all rather than being
 * coerced: a malformed value is the user's, and overwriting it would lose it.
 */
function readAliases(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Maintains the plugin's title alias (FR-4.11).
 *
 * `next` is the title to hold, or `null` when the file name is already the title
 * and no alias is needed. `previous` is the alias written last time, the only
 * entry this function may remove — every other entry belongs to the user
 * (§6.5.1).
 *
 * Mutates the record because that is the contract of Obsidian's
 * `processFrontMatter` callback, which is the only sanctioned way to touch
 * frontmatter (§7.4).
 */
export function applyAlias(
  frontmatter: Record<string, unknown>,
  next: string | null,
  previous: string | null,
): void {
  const existing = readAliases(frontmatter[ALIASES_KEY]);
  const kept = existing.filter((alias) => alias !== previous && alias !== next);
  const aliases = next === null ? kept : [...kept, next];

  // An empty list is deleted rather than written: `aliases: []` in every note of
  // a mirror is noise the user did not ask for.
  if (aliases.length === 0) delete frontmatter[ALIASES_KEY];
  else frontmatter[ALIASES_KEY] = aliases;
}

/** Frontmatter block plus body, as split by `splitFrontmatter`. */
export interface SplitNote {
  /** The delimited block including both `---` lines and the trailing newline, or `''`. */
  readonly frontmatter: string;
  readonly body: string;
}

const DELIMITER = /^---[ \t]*$/;

/**
 * Separates a leading frontmatter block from the body.
 *
 * Deliberately *not* YAML parsing: the block is carried across a body rewrite
 * byte for byte, so the user's keys, comments, ordering and quoting style are
 * all preserved exactly. Only the `confluence` key is ever rewritten, and that
 * goes through Obsidian's own frontmatter API (spec §7.4).
 */
export function splitFrontmatter(content: string): SplitNote {
  const lines = content.split('\n');
  const first = lines[0];
  if (first === undefined || !DELIMITER.test(first.replace(/\r$/, ''))) {
    return { frontmatter: '', body: content };
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !DELIMITER.test(line.replace(/\r$/, ''))) continue;

    return {
      frontmatter: `${lines.slice(0, index + 1).join('\n')}\n`,
      body: lines.slice(index + 1).join('\n'),
    };
  }

  // An unterminated block is not frontmatter — Obsidian treats it as body text,
  // and rewriting around it would move content the user can see into a region
  // they cannot.
  return { frontmatter: '', body: content };
}

/**
 * Rebuilds a note from a preserved frontmatter block and a new body.
 *
 * The body always ends in exactly one newline: converter output does not
 * guarantee one, and a note whose trailing whitespace drifted between syncs
 * would hash differently every time and look permanently modified.
 */
export function joinFrontmatter(frontmatter: string, body: string): string {
  const trimmed = body.replace(/^\n+/, '').replace(/\s*$/, '');
  return trimmed.length === 0 ? frontmatter : `${frontmatter}${trimmed}\n`;
}
