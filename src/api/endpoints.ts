import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';

/**
 * Base URL handling and Confluence Data Center REST v1 paths.
 *
 * Pure string work — no I/O — so every edge case is unit-testable.
 */

/** Query values; `undefined` entries are omitted rather than serialised. */
export type QueryParams = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Normalises a user-entered base URL.
 *
 * Accepts a reverse-proxy context path (spec FR-1.2), tolerates a missing
 * scheme, and strips a trailing `/rest/api` — pasting the API root instead of
 * the site root is the most common setup mistake.
 */
export function normaliseBaseUrl(raw: string): Result<string, AppError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err(new AppError('INVALID_BASE_URL', 'Enter the URL of your Confluence site.'));
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return err(new AppError('INVALID_BASE_URL', `"${trimmed}" is not a valid URL.`));
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return err(
      new AppError('INVALID_BASE_URL', 'The Confluence URL must start with https:// or http://.'),
    );
  }
  if (parsed.hostname.length === 0) {
    return err(new AppError('INVALID_BASE_URL', 'The Confluence URL is missing a host name.'));
  }

  const path = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/rest\/api$/i, '')
    .replace(/\/rest$/i, '');

  return ok(`${parsed.protocol}//${parsed.host}${path}`);
}

function serialiseQuery(query: QueryParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const serialised = params.toString();
  return serialised.length === 0 ? '' : `?${serialised}`;
}

/** Joins a normalised base URL with an API path and query parameters. */
export function buildUrl(baseUrl: string, path: string, query: QueryParams = {}): string {
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalisedPath}${serialiseQuery(query)}`;
}

/**
 * Confluence Data Center REST v1 paths (spec §6.2.1). Cloud's v2 API does not
 * exist here — Data Center is the only supported target (decision D1).
 */
export const ENDPOINTS = {
  currentUser: '/rest/api/user/current',
  spaces: '/rest/api/space',
  spaceByKey: (key: string): string => `/rest/api/space/${encodeURIComponent(key)}`,
  content: '/rest/api/content',
  contentSearch: '/rest/api/content/search',
  contentById: (id: string): string => `/rest/api/content/${encodeURIComponent(id)}`,
  childPages: (id: string): string => `/rest/api/content/${encodeURIComponent(id)}/child/page`,
  attachments: (id: string): string =>
    `/rest/api/content/${encodeURIComponent(id)}/child/attachment`,
  comments: (id: string): string => `/rest/api/content/${encodeURIComponent(id)}/child/comment`,
  labels: (id: string): string => `/rest/api/content/${encodeURIComponent(id)}/label`,

  /**
   * Version detection, in fallback order.
   *
   * Data Center exposes no single guaranteed version endpoint. The applinks
   * manifest returns a `<version>` element and is the most reliable route;
   * `settings/systemInfo` is primarily a Cloud endpoint and must not be
   * assumed present. Confirm the working route against a live instance before
   * relying on it for the FR-1.7 compatibility gate.
   */
  versionProbes: ['/rest/applinks/1.0/manifest', '/rest/api/settings/systemInfo'] as const,
} as const;
