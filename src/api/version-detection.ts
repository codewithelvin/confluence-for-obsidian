import { asNonEmptyString, isRecord } from '../util/guards';
import { parseVersion, type SemanticVersion } from '../util/version';

/**
 * Confluence Data Center version detection.
 *
 * DC exposes no single guaranteed version endpoint, so detection is a fallback
 * chain (see ENDPOINTS.versionProbes). Both parsers must tolerate an entirely
 * unexpected body: a reverse proxy or SSO portal will happily return an HTML
 * login page with status 200.
 */

/**
 * Parses the applinks manifest, the most reliable DC route:
 * `<applinks-manifest><version>7.19.6</version>...`
 */
export function parseVersionFromManifest(xml: string): SemanticVersion | null {
  if (typeof DOMParser === 'undefined') return null;

  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) return null;

  const element = document.getElementsByTagName('version')[0];
  const text = element?.textContent;
  if (text === null || text === undefined) return null;

  return parseVersion(text);
}

/** Parses a `systemInfo`-style JSON body, checking the fields DC builds vary across. */
export function parseVersionFromSystemInfo(raw: unknown): SemanticVersion | null {
  if (!isRecord(raw)) return null;

  for (const key of ['version', 'confluenceVersion', 'buildNumber'] as const) {
    const value = asNonEmptyString(raw[key]);
    if (value === null) continue;
    const parsed = parseVersion(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Applies whichever parser suits the body, so callers need not pre-classify it. */
export function parseVersionFromBody(body: string): SemanticVersion | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('<')) return parseVersionFromManifest(trimmed);

  try {
    return parseVersionFromSystemInfo(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
