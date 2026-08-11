import { AppError } from '../util/errors';
import {
  asArray,
  asFiniteNumber,
  asNonEmptyString,
  asString,
  isRecord,
  readPath,
} from '../util/guards';
import { err, ok, type Result } from '../util/result';

/**
 * Confluence Data Center REST v1 response shapes, with runtime validators.
 *
 * A 200 response is not a type guarantee (spec §7.2): reverse proxies return
 * HTML login pages with 200, and instances differ by version and plugin set.
 * Nothing reaches the rest of the plugin without passing through here.
 */

export interface ConfluenceUser {
  readonly username: string;
  readonly displayName: string;
}

export interface ConfluenceSpace {
  readonly key: string;
  readonly name: string;
  /** `global` or `personal`. Personal spaces are noisy and filtered by default. */
  readonly type: string;
  /**
   * Id of the space's home page — present only when the request asked for
   * `expand=homepage`, and `null` for a space that has none.
   *
   * The home page collapses into the mount folder (D13), so the whole layout of
   * a whole-space subscription hangs off this one value.
   */
  readonly homepageId: string | null;
}

export interface PagedResult<T> {
  readonly results: readonly T[];
  readonly start: number;
  readonly limit: number;
  readonly size: number;
  /**
   * Total matches across every page, when the endpoint reports it.
   *
   * CQL search returns it; the plain content endpoint does not. `null` means
   * "unknown", never "zero" — the subscription size warning (FR-2.4) must not
   * claim a space is empty because an endpoint stayed silent.
   */
  readonly totalSize: number | null;
  /** Relative path of the next page, or `null` at the end of the collection. */
  readonly nextPath: string | null;
}

export interface ConfluencePageSummary {
  readonly id: string;
  readonly title: string;
}

/**
 * A page's identity, position and version — everything sync needs to decide
 * whether to fetch the body, without paying to transfer it.
 */
export interface ConfluencePageRef extends ConfluencePageSummary {
  readonly spaceKey: string;
  readonly version: number;
  /** Immediate parent, or `null` for a top-level page. */
  readonly parentId: string | null;
  /** ISO-8601 timestamp of the last edit, or `''` when the server omitted it. */
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ConfluencePage extends ConfluencePageRef {
  /** The `body.storage` value — the format everything else is derived from. */
  readonly storage: string;
}

export type Parser<T> = (raw: unknown) => Result<T, AppError>;

function malformed(what: string): AppError {
  return new AppError(
    'MALFORMED_RESPONSE',
    `Confluence returned an unexpected response for ${what}. ` +
      'If your instance sits behind a proxy or SSO portal, the plugin may be receiving a login page.',
  );
}

export const parseUser: Parser<ConfluenceUser> = (raw) => {
  if (!isRecord(raw)) return err(malformed('the current user'));

  // Data Center reports `username`; some builds only populate `userKey`.
  const username = asNonEmptyString(raw['username']) ?? asNonEmptyString(raw['userKey']);
  if (username === null) return err(malformed('the current user'));

  return ok({
    username,
    displayName: asNonEmptyString(raw['displayName']) ?? username,
  });
};

export const parseSpace: Parser<ConfluenceSpace> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a space'));

  const key = asNonEmptyString(raw['key']);
  if (key === null) return err(malformed('a space'));

  return ok({
    key,
    name: asNonEmptyString(raw['name']) ?? key,
    type: asNonEmptyString(raw['type']) ?? 'global',
    homepageId: asNonEmptyString(readPath(raw, 'homepage', 'id')),
  });
};

export const parsePageSummary: Parser<ConfluencePageSummary> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a page'));

  const id = asNonEmptyString(raw['id']);
  if (id === null) return err(malformed('a page'));

  return ok({ id, title: asNonEmptyString(raw['title']) ?? '(untitled)' });
};

/**
 * Reads identity, position and version.
 *
 * The immediate parent is the *last* ancestor: Confluence returns the chain
 * root-first, so taking the first would reparent every page to the top of the
 * space and flatten the whole hierarchy.
 */
function readRef(raw: Record<string, unknown>, id: string): ConfluencePageRef {
  const ancestors = asArray(readPath(raw, 'ancestors')) ?? [];
  const parent = ancestors.length === 0 ? undefined : ancestors[ancestors.length - 1];

  return {
    id,
    title: asNonEmptyString(raw['title']) ?? '(untitled)',
    spaceKey: asNonEmptyString(readPath(raw, 'space', 'key')) ?? '',
    version: asFiniteNumber(readPath(raw, 'version', 'number')) ?? 1,
    parentId: asNonEmptyString(readPath(parent, 'id')),
    updatedAt: asNonEmptyString(readPath(raw, 'version', 'when')) ?? '',
    updatedBy:
      asNonEmptyString(readPath(raw, 'version', 'by', 'username')) ??
      asNonEmptyString(readPath(raw, 'version', 'by', 'displayName')) ??
      '',
  };
}

/**
 * Validates a page reference — everything except the body.
 *
 * This is what subtree enumeration returns. Fetching 500 bodies to discover
 * that three changed would blow the §7.1 sync budget on its own.
 */
export const parsePageRef: Parser<ConfluencePageRef> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a page'));

  const id = asNonEmptyString(raw['id']);
  if (id === null) return err(malformed('a page'));

  return ok(readRef(raw, id));
};

/**
 * Validates a full page. The storage body is required: a page fetched without
 * `expand=body.storage` would otherwise convert to an empty note, which on a
 * later push would blank the page in Confluence.
 */
export const parsePage: Parser<ConfluencePage> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a page'));

  const id = asNonEmptyString(raw['id']);
  const storage = asString(readPath(raw, 'body', 'storage', 'value'));
  if (id === null || storage === null) return err(malformed('a page body'));

  return ok({ ...readRef(raw, id), storage });
};

/**
 * Validates a paged envelope. Individual malformed entries are dropped rather
 * than failing the whole page — one bad space must not make the space browser
 * unusable — but a malformed envelope is a hard error.
 */
export function parsePaged<T>(
  raw: unknown,
  parseItem: Parser<T>,
): Result<PagedResult<T>, AppError> {
  if (!isRecord(raw)) return err(malformed('a paged collection'));

  const rawResults = asArray(raw['results']);
  if (rawResults === null) return err(malformed('a paged collection'));

  const results: T[] = [];
  for (const item of rawResults) {
    const parsed = parseItem(item);
    if (parsed.ok) results.push(parsed.value);
  }

  const next = asString(readPath(raw, '_links', 'next'));

  return ok({
    results,
    start: asFiniteNumber(raw['start']) ?? 0,
    limit: asFiniteNumber(raw['limit']) ?? results.length,
    size: asFiniteNumber(raw['size']) ?? results.length,
    totalSize: asFiniteNumber(raw['totalSize']),
    nextPath: next,
  });
}
