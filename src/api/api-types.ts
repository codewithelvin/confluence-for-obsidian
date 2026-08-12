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
  /**
   * Label names, without their namespace prefix (spec FR-9.1).
   *
   * Present only when the request asked for `expand=metadata.labels`. An empty
   * list therefore means "none expanded" as well as "none set" — which is safe
   * in both directions here, because FR-9.2 diffs against what the plugin last
   * recorded rather than against this value.
   */
  readonly labels: readonly string[];
}

/** Where a comment is anchored (spec FR-9.3). */
export type CommentLocation = 'footer' | 'inline';

/**
 * One comment on a page, as `child/comment` reports it.
 *
 * The body arrives as storage format and is reduced to plain text for the managed
 * region — the region is read-only and never pushed (FR-5.8), so nothing in it
 * has to survive a round trip.
 */
export interface ConfluenceComment {
  readonly id: string;
  readonly author: string;
  /** ISO-8601 creation time, or `''` when the instance did not report one. */
  readonly createdAt: string;
  readonly storage: string;
  readonly location: CommentLocation;
  /**
   * The inline marker this comment is attached to, or `null` for a footer comment.
   *
   * Matches the `ref` of the `<!--cf-comment:REF-->` carrier the converter leaves
   * in the body (§6.4), which is what lets a reader tie a remark to the sentence
   * it is about instead of to the page as a whole.
   */
  readonly inlineRef: string | null;
}

/**
 * A comment as the *change* query reports it (§16 O16).
 *
 * Deliberately not a `ConfluenceComment`: this search never asks for a body, because
 * all the sync needs from it is which page to re-pull and when the comment moved.
 * Asking for bodies here would download every changed comment in the space twice —
 * once to find the pages, and again when each of those pages is pulled.
 */
export interface ConfluenceCommentRef {
  readonly id: string;
  /** The page the comment hangs off, from `expand=container`. */
  readonly pageId: string;
  /** ISO-8601 instant carrying the server's own offset. Compared as a date, never as text. */
  readonly updatedAt: string;
}

/** An attachment on a page, as the `child/attachment` endpoint reports it. */
export interface ConfluenceAttachment {
  readonly id: string;
  /** Title, which for an attachment is its file name — what `ri:filename` matches. */
  readonly filename: string;
  readonly version: number;
  /** Bytes, or `null` when the instance did not report a size (FR-8.4 then cannot judge). */
  readonly size: number | null;
  /**
   * Path the bytes come from, relative to the site root and already carrying the
   * version query Confluence puts there. Taken from the response rather than
   * assembled, because it is the one form guaranteed to be right.
   */
  readonly downloadPath: string;
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

  // A rejected or absent token is not answered with 401 on every instance. Measured
  // on 7.19.6 (2026-08-12): a nonsense bearer token returns 200 and an *anonymous*
  // user, after which reads degrade silently — a space the account can see comes back
  // 404 — and the first write answers 403 `Could not create content with type page`,
  // which reads as a permission problem rather than as the authentication failure it
  // is. Caught by name here so the remedy points at the token instead of at the
  // space's permission screen.
  if (asString(raw['type']) === 'anonymous') {
    return err(
      new AppError(
        'AUTH_FAILED',
        'Confluence answered as Anonymous, so it did not accept the token. Check that the ' +
          'personal access token in settings is current and belongs to this instance.',
        { action: 'open-settings' },
      ),
    );
  }

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

export const parseAttachment: Parser<ConfluenceAttachment> = (raw) => {
  if (!isRecord(raw)) return err(malformed('an attachment'));

  const id = asNonEmptyString(raw['id']);
  const filename = asNonEmptyString(raw['title']);
  const downloadPath = asNonEmptyString(readPath(raw, '_links', 'download'));
  if (id === null || filename === null || downloadPath === null) {
    return err(malformed('an attachment'));
  }

  return ok({
    id,
    filename,
    version: asFiniteNumber(readPath(raw, 'version', 'number')) ?? 0,
    size: asFiniteNumber(readPath(raw, 'extensions', 'fileSize')),
    downloadPath,
  });
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

  return ok({ ...readRef(raw, id), storage, labels: readLabels(raw) });
};

/**
 * Label names from `metadata.labels` (spec FR-9.1).
 *
 * An entry without a usable name is skipped rather than failing the page: a label
 * the plugin cannot read is one tag missing, while refusing the response loses
 * the whole body.
 */
function readLabels(raw: Record<string, unknown>): readonly string[] {
  const results = asArray(readPath(raw, 'metadata', 'labels', 'results')) ?? [];

  return results.flatMap((entry) => {
    const name = asNonEmptyString(readPath(entry, 'name'));
    return name === null ? [] : [name];
  });
}

/**
 * Validates a comment reference from the change query (§16 O16).
 *
 * A record with no container is dropped rather than failing the search: a comment
 * whose page the response does not name is one the sync could not act on anyway, and
 * `parsePaged` already treats an unreadable entry as one fewer result.
 */
export const parseCommentRef: Parser<ConfluenceCommentRef> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a comment'));

  const id = asNonEmptyString(raw['id']);
  const pageId = asNonEmptyString(readPath(raw, 'container', 'id'));
  if (id === null || pageId === null) return err(malformed('a comment'));

  return ok({
    id,
    pageId,
    updatedAt:
      asNonEmptyString(readPath(raw, 'version', 'when')) ??
      asNonEmptyString(readPath(raw, 'history', 'lastUpdated', 'when')) ??
      '',
  });
};

/**
 * Validates a comment.
 *
 * The author is the comment's *creator* rather than whoever last edited it: the
 * region attributes a remark to the person who made it, and `version.by` on an
 * edited comment is not that person.
 */
export const parseComment: Parser<ConfluenceComment> = (raw) => {
  if (!isRecord(raw)) return err(malformed('a comment'));

  const id = asNonEmptyString(raw['id']);
  const storage = asString(readPath(raw, 'body', 'storage', 'value'));
  if (id === null || storage === null) return err(malformed('a comment'));

  return ok({
    id,
    storage,
    author:
      asNonEmptyString(readPath(raw, 'history', 'createdBy', 'displayName')) ??
      asNonEmptyString(readPath(raw, 'history', 'createdBy', 'username')) ??
      asNonEmptyString(readPath(raw, 'version', 'by', 'displayName')) ??
      'Unknown',
    createdAt:
      asNonEmptyString(readPath(raw, 'history', 'createdDate')) ??
      asNonEmptyString(readPath(raw, 'version', 'when')) ??
      '',
    location:
      asNonEmptyString(readPath(raw, 'extensions', 'location')) === 'inline' ? 'inline' : 'footer',
    inlineRef: asNonEmptyString(readPath(raw, 'extensions', 'inlineProperties', 'ref')),
  });
};

/** What a page update reports back: the version the edit now sits at (FR-5.4). */
export interface ConfluencePageVersion {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * Validates the response to a page update.
 *
 * `version.number` is required rather than defaulted: it is the whole point of
 * the response, and recording a guessed version would make the *next* push send
 * a stale one — a conflict the user never caused.
 */
export const parseUpdatedPage: Parser<ConfluencePageVersion> = (raw) => {
  if (!isRecord(raw)) return err(malformed('an updated page'));

  const id = asNonEmptyString(raw['id']);
  const version = asFiniteNumber(readPath(raw, 'version', 'number'));
  if (id === null || version === null) return err(malformed('an updated page'));

  const ref = readRef(raw, id);
  return ok({
    id,
    title: ref.title,
    version,
    updatedAt: ref.updatedAt,
    updatedBy: ref.updatedBy,
  });
};

/**
 * Validates the response to an attachment upload (spec FR-8.6).
 *
 * Confluence answers a `POST` to `child/attachment` with a paged collection
 * holding the one attachment it created, so the envelope is unwrapped here rather
 * than at the call site. An empty collection is an error: the caller is about to
 * write a page body referring to the file by name, and doing that without proof
 * the upload landed would publish an embed pointing at nothing.
 */
export const parseUploadedAttachment: Parser<ConfluenceAttachment> = (raw) => {
  const paged = parsePaged(raw, parseAttachment);
  if (!paged.ok) return paged;

  const first = paged.value.results[0];
  return first === undefined ? err(malformed('an uploaded attachment')) : ok(first);
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
