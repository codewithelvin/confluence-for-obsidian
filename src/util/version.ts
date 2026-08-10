/**
 * Confluence version parsing and comparison.
 *
 * Segment-wise numeric comparison is required, not string comparison: the
 * client instance reports 7.19.6, and "7.19.6" < "7.9" lexicographically while
 * 7.19.6 is in fact the newer release.
 */

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/** Extracts a version from a string, tolerating suffixes such as "7.19.6-EAP". */
export function parseVersion(raw: string): SemanticVersion | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (match === null) return null;

  const major = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(major)) return null;

  return {
    major,
    minor: Number.parseInt(match[2] ?? '0', 10),
    patch: Number.parseInt(match[3] ?? '0', 10),
    raw: raw.trim(),
  };
}

/** Returns a negative number if `a` is older than `b`, 0 if equal, positive if newer. */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Minimum Confluence Data Center version supporting Personal Access Tokens (spec D5). */
export const MINIMUM_SUPPORTED_VERSION: SemanticVersion = {
  major: 7,
  minor: 9,
  patch: 0,
  raw: '7.9',
};

export function meetsMinimumVersion(version: SemanticVersion): boolean {
  return compareVersions(version, MINIMUM_SUPPORTED_VERSION) >= 0;
}
