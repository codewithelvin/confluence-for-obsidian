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

/**
 * Marks the read-only copy of a remote page written by a "Save Both" conflict
 * resolution (spec FR-6.4).
 *
 * A second reserved key rather than a field inside `confluence`, because the two
 * mean opposite things: `confluence` says "this note *is* that page", and this
 * says "this note is a snapshot beside it". A copy carrying the first would be
 * mistaken for the note itself and pushed over the page it was saved to protect.
 *
 * FR-6.4 asks for the copy to be excluded from sync; this key is how the mount
 * scan recognises one, so it is reported as neither tracked nor untracked.
 */
export const CONFLICT_COPY_KEY = 'confluenceRemoteCopy';

/**
 * Obsidian's own tag key, which the plugin *shares* the way it shares `aliases`:
 * it maintains the entries standing for the page's Confluence labels (FR-9.1) and
 * leaves every other entry alone.
 */
export const TAGS_KEY = 'tags';

/**
 * Suppresses the managed comments region for one note (spec FR-9.6, §16 O5).
 *
 * A third reserved key, and the only place a per-page opt-out can live: FR-9.4
 * regenerates the region wholesale on every pull, so anything recorded inside it
 * is gone by the next sync, and frontmatter is the one part of the note that
 * survives. `false` silences comments for this note; absent or `true` leaves the
 * decision to the subscription's own switch (FR-9.5). It never turns comments
 * *on* against that switch — a user who disabled them for a whole space did so
 * for a reason.
 */
export const COMMENTS_KEY = 'confluenceComments';

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

/** The snapshot a "Save Both" resolution keeps beside the note (spec FR-6.4). */
export interface ConflictCopy {
  readonly pageId: string;
  readonly space: string;
  readonly version: number;
  readonly updated: string;
  readonly updatedBy: string;
  readonly url: string;
}

export function toConflictCopyValue(copy: ConflictCopy): Record<string, unknown> {
  return {
    pageId: copy.pageId,
    space: copy.space,
    version: copy.version,
    updated: copy.updated,
    updatedBy: copy.updatedBy,
    url: copy.url,
    note: 'Read-only snapshot of the Confluence page. Not synced. Delete it once merged.',
  };
}

/**
 * Whether parsed frontmatter marks the file a conflict copy.
 *
 * Only the key's presence is checked. Anything under it is descriptive, and a
 * copy whose fields were hand-edited must still be excluded from sync — the
 * exclusion is the safety property, and the details are only there for the reader.
 */
export function isConflictCopy(frontmatter: unknown): boolean {
  return isRecord(frontmatter) && frontmatter[CONFLICT_COPY_KEY] !== undefined;
}

/**
 * File name for the copy (spec FR-6.4): `<Title> (remote v43).md`, beside the note.
 *
 * Built from the note's own path rather than the page title, so a title that was
 * sanitised or truncated on the way in (§6.5.2, §6.5.3) produces a copy sitting
 * next to the file it belongs to instead of one the user cannot associate with it.
 */
export function conflictCopyPath(notePath: string, remoteVersion: number): string {
  const base = notePath.replace(/\.md$/i, '');
  return `${base} (remote v${String(remoteVersion)}).md`;
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

/**
 * Reads `tags`, which Obsidian accepts as a list or as one string.
 *
 * A numeric entry is read back as text: YAML turns an unquoted `2026` into a
 * number, and a release label of `2026` is still the label Confluence holds.
 */
export function readTags(frontmatter: unknown): readonly string[] {
  if (!isRecord(frontmatter)) return [];
  const value = frontmatter[TAGS_KEY];

  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((tag) => tag.replace(/^#/, ''))
      .filter((tag) => tag.length > 0);
  }
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.length === 0 ? [] : [entry.replace(/^#/, '')];
    return typeof entry === 'number' && Number.isFinite(entry) ? [String(entry)] : [];
  });
}

/**
 * Maintains the tags standing for the page's labels (FR-9.1).
 *
 * `next` is the page's current label set and `previous` is the set written last
 * time — the only entries this function may remove. Every other tag is the user's
 * (§6.5.1), including one that happens to match a label: it is compared
 * case-insensitively and left in place rather than replaced by Confluence's
 * lower-cased spelling of the same word.
 *
 * Mutates, because that is the contract of `processFrontMatter` — the only
 * sanctioned way to touch frontmatter (§7.4).
 */
export function applyTags(
  frontmatter: Record<string, unknown>,
  next: readonly string[],
  previous: readonly string[],
): void {
  const fold = (tag: string): string => tag.toLowerCase();
  const dropped = new Set(previous.map(fold));

  const kept = readTags(frontmatter).filter((tag) => !dropped.has(fold(tag)));
  const present = new Set(kept.map(fold));
  const tags = [...kept, ...next.filter((tag) => !present.has(fold(tag)))];

  // An empty list is deleted rather than written: `tags: []` in every note of a
  // mirror is noise the user did not ask for.
  if (tags.length === 0) delete frontmatter[TAGS_KEY];
  else frontmatter[TAGS_KEY] = tags;
}

/**
 * Whether this note has opted out of the comments region (FR-9.6).
 *
 * Only an explicit `false` counts. The string form is accepted too, because the
 * key is meant to be typed by hand and a quoted `"false"` is what a careful user
 * writes when they are unsure how YAML treats booleans.
 */
export function commentsDisabled(frontmatter: unknown): boolean {
  if (!isRecord(frontmatter)) return false;
  const value = frontmatter[COMMENTS_KEY];
  return value === false || value === 'false';
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
