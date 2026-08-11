/**
 * Turning Confluence page titles into file names (spec §6.5.2, §6.5.3).
 *
 * Pure and deterministic: the same title and page id always produce the same
 * name, so a re-sync never renames a file it created earlier.
 */

/**
 * Characters no Windows path may contain, plus control characters.
 *
 * Spaces are deliberately absent — page titles are full of them and they are
 * perfectly legal in file names.
 */
const ILLEGAL_CHARACTERS = '<>:"/\\|?*';

/**
 * Checked per character rather than with a regular expression.
 *
 * A character class built from a string needs its backslash escaped twice —
 * once for the string and once for the pattern — and getting that wrong lets
 * backslashes through into file names without any error.
 */
function isIllegal(character: string): boolean {
  return character.charCodeAt(0) < 32 || ILLEGAL_CHARACTERS.includes(character);
}

/**
 * Device names Windows reserves, with or without an extension: `CON.md` is as
 * unusable as `CON`.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
]);

/**
 * Longest absolute path this plugin will create.
 *
 * Windows caps paths at 260 characters unless long-path support is enabled, and
 * the folder-note layout roughly doubles the cost of each level of hierarchy
 * (spec risk R2). The budget leaves room for the extension and for the vault
 * later moving somewhere deeper.
 */
export const MAX_ABSOLUTE_PATH = 240;

/** Distinguishing suffix from a page id, used when a name must be shortened or de-duplicated. */
export function idSuffix(pageId: string): string {
  return `~${pageId.slice(-6)}`;
}

/**
 * Makes a single path segment safe. Length and sibling collisions are handled
 * separately by `fitToBudget` and `disambiguate`.
 */
export function sanitiseSegment(title: string): string {
  const replaced = Array.from(title)
    .map((character) => (isIllegal(character) ? '-' : character))
    .join('');

  const cleaned = replaced
    .replace(/[.\s]+$/, '')
    .replace(/-{2,}/g, '-')
    .trim();

  if (cleaned.length === 0) return 'Untitled';

  const withoutExtension = cleaned.replace(/\.[^.]*$/, '');
  return RESERVED.has(withoutExtension.toLowerCase()) ? `${cleaned}_` : cleaned;
}

/**
 * Makes an attachment's file name safe **without touching its extension**
 * (spec FR-8.1).
 *
 * `sanitiseSegment` would append its reserved-name underscore after the
 * extension — `con.png` becoming `con.png_` — and Obsidian identifies an image
 * by its extension, so that one character is the difference between a picture
 * and an unknown file.
 */
export function sanitiseFileName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return sanitiseSegment(filename);

  const stem = sanitiseSegment(filename.slice(0, dot));
  const extension = sanitiseSegment(filename.slice(dot + 1));
  return `${stem}.${extension}`;
}

/**
 * Resolves a collision between siblings.
 *
 * Confluence enforces unique titles within a space, so a collision can only come
 * from sanitisation — two titles differing solely by an illegal character.
 */
export function disambiguate(segment: string, pageId: string, taken: ReadonlySet<string>): string {
  if (!taken.has(segment.toLowerCase())) return segment;
  return `${segment} ${idSuffix(pageId)}`;
}

/**
 * Longest segment that keeps the finished path inside the budget.
 *
 * `occurrences` is what makes the folder-note layout survivable: a page with
 * children is stored as `Title/Title.md`, so its name is spent **twice** on one
 * path (decision D9). Charging it once would let a deep tree of long titles
 * pass the check and then fail at write time on Windows — exactly risk R2.
 *
 * Fixed cost is the parent directory, the separators (one before the segment,
 * one more between a folder and its note) and the `.md` extension.
 */
export function segmentBudget(parentDirLength: number, occurrences: number): number {
  const fixed = parentDirLength + occurrences + '.md'.length;
  return Math.floor((MAX_ABSOLUTE_PATH - fixed) / occurrences);
}

/**
 * Shortens a segment to `maxLength`.
 *
 * The id suffix is kept, so a truncated name still identifies its page and stays
 * stable across syncs.
 */
export function fitToBudget(segment: string, pageId: string, maxLength: number): string {
  if (segment.length <= maxLength) return segment;

  const suffix = idSuffix(pageId);
  const room = maxLength - suffix.length;
  if (room <= 0) return suffix;

  return `${segment.slice(0, room).trimEnd()}${suffix}`;
}

/**
 * Whether a path is over budget even when its name is shortened to nothing but
 * the page id. Such a page cannot be written at all and is reported rather than
 * silently skipped.
 */
export function isUnfixablyLong(maxLength: number, pageId: string): boolean {
  return maxLength < idSuffix(pageId).length;
}
