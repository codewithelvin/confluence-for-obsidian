import { describe, expect, it } from 'vitest';
import { ENDPOINTS, buildUrl, normaliseBaseUrl } from '../../src/api/endpoints';

function expectUrl(input: string): string {
  const result = normaliseBaseUrl(input);
  expect(result.ok, `expected "${input}" to normalise, got error`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function expectRejected(input: string): string {
  const result = normaliseBaseUrl(input);
  expect(result.ok, `expected "${input}" to be rejected`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.error.code;
}

describe('normaliseBaseUrl', () => {
  it('keeps a plain host', () => {
    expect(expectUrl('https://wiki.corp')).toBe('https://wiki.corp');
  });

  it('preserves a reverse-proxy context path', () => {
    expect(expectUrl('https://wiki.corp/confluence')).toBe('https://wiki.corp/confluence');
  });

  it('strips trailing slashes', () => {
    expect(expectUrl('https://wiki.corp/confluence/')).toBe('https://wiki.corp/confluence');
    expect(expectUrl('https://wiki.corp///')).toBe('https://wiki.corp');
  });

  it('assumes https when no scheme is given', () => {
    expect(expectUrl('wiki.corp/confluence')).toBe('https://wiki.corp/confluence');
  });

  it('keeps an explicit http scheme', () => {
    expect(expectUrl('http://wiki.internal:8090')).toBe('http://wiki.internal:8090');
  });

  it('keeps a non-default port', () => {
    expect(expectUrl('https://wiki.corp:8443/confluence')).toBe(
      'https://wiki.corp:8443/confluence',
    );
  });

  it('strips a pasted API root', () => {
    // Pasting the API root instead of the site root is the most common setup
    // mistake; silently accepting it would produce /rest/api/rest/api/... URLs.
    expect(expectUrl('https://wiki.corp/confluence/rest/api')).toBe('https://wiki.corp/confluence');
    expect(expectUrl('https://wiki.corp/rest')).toBe('https://wiki.corp');
  });

  it('discards query strings and fragments', () => {
    expect(expectUrl('https://wiki.corp/confluence?x=1#y')).toBe('https://wiki.corp/confluence');
  });

  it('trims surrounding whitespace', () => {
    expect(expectUrl('  https://wiki.corp  ')).toBe('https://wiki.corp');
  });

  it('rejects empty input', () => {
    expect(expectRejected('')).toBe('INVALID_BASE_URL');
    expect(expectRejected('   ')).toBe('INVALID_BASE_URL');
  });

  it('rejects non-http schemes', () => {
    expect(expectRejected('ftp://wiki.corp')).toBe('INVALID_BASE_URL');
    expect(expectRejected('file:///etc/passwd')).toBe('INVALID_BASE_URL');
  });

  it('rejects input the URL parser cannot handle, rather than throwing', () => {
    expect(expectRejected('https://[')).toBe('INVALID_BASE_URL');
    expect(expectRejected('http://:::')).toBe('INVALID_BASE_URL');
  });
});

describe('buildUrl', () => {
  it('joins a base and a path', () => {
    expect(buildUrl('https://wiki.corp/confluence', '/rest/api/space')).toBe(
      'https://wiki.corp/confluence/rest/api/space',
    );
  });

  it('tolerates a path without a leading slash', () => {
    expect(buildUrl('https://wiki.corp', 'rest/api/space')).toBe(
      'https://wiki.corp/rest/api/space',
    );
  });

  it('appends query parameters', () => {
    expect(buildUrl('https://wiki.corp', '/x', { start: 0, limit: 50 })).toBe(
      'https://wiki.corp/x?start=0&limit=50',
    );
  });

  it('omits undefined parameters rather than serialising them', () => {
    expect(buildUrl('https://wiki.corp', '/x', { a: 1, b: undefined })).toBe(
      'https://wiki.corp/x?a=1',
    );
  });

  it('adds no question mark when every parameter is undefined', () => {
    expect(buildUrl('https://wiki.corp', '/x', { a: undefined })).toBe('https://wiki.corp/x');
  });

  it('encodes parameter values', () => {
    const url = buildUrl('https://wiki.corp', '/x', { cql: 'space = "ENG" AND type = page' });
    expect(url).toContain('cql=space+%3D+%22ENG%22+AND+type+%3D+page');
  });
});

describe('ENDPOINTS', () => {
  it('targets the Data Center v1 API, never Cloud v2', () => {
    expect(ENDPOINTS.content).toBe('/rest/api/content');
    expect(ENDPOINTS.spaces).not.toContain('/api/v2/');
  });

  it('encodes page ids into paths', () => {
    expect(ENDPOINTS.contentById('12 3')).toBe('/rest/api/content/12%203');
    expect(ENDPOINTS.childPages('456')).toBe('/rest/api/content/456/child/page');
    expect(ENDPOINTS.attachments('456')).toBe('/rest/api/content/456/child/attachment');
    expect(ENDPOINTS.comments('456')).toBe('/rest/api/content/456/child/comment');
    expect(ENDPOINTS.labels('456')).toBe('/rest/api/content/456/label');
  });

  it('encodes ids that would otherwise break the path', () => {
    expect(ENDPOINTS.contentById('a/b')).toBe('/rest/api/content/a%2Fb');
    expect(ENDPOINTS.labels('x?y')).toBe('/rest/api/content/x%3Fy/label');
  });

  it('probes the applinks manifest before systemInfo', () => {
    // systemInfo is primarily a Cloud endpoint; the applinks manifest is the
    // reliable Data Center route and must be tried first.
    expect(ENDPOINTS.versionProbes[0]).toBe('/rest/applinks/1.0/manifest');
  });
});
