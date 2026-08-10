import { describe, expect, it } from 'vitest';
import {
  parseVersionFromBody,
  parseVersionFromManifest,
  parseVersionFromSystemInfo,
} from '../../src/api/version-detection';

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<applinks-manifest>
  <id>8a7f6b</id>
  <name>Confluence</name>
  <typeId>confluence</typeId>
  <version>7.19.6</version>
  <buildNumber>8703</buildNumber>
</applinks-manifest>`;

/** What a reverse proxy or SSO portal returns instead of the API. */
const LOGIN_PAGE = '<!DOCTYPE html><html><body><form id="login">Sign in</form></body></html>';

describe('parseVersionFromManifest', () => {
  it('reads the version from an applinks manifest', () => {
    expect(parseVersionFromManifest(MANIFEST)).toMatchObject({ major: 7, minor: 19, patch: 6 });
  });

  it('returns null when the manifest has no version element', () => {
    expect(
      parseVersionFromManifest('<applinks-manifest><name>x</name></applinks-manifest>'),
    ).toBeNull();
  });

  it('returns null for malformed XML rather than throwing', () => {
    expect(parseVersionFromManifest('<applinks-manifest><version>7.19.6')).toBeNull();
  });

  it('returns null for an HTML login page', () => {
    expect(parseVersionFromManifest(LOGIN_PAGE)).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(parseVersionFromManifest('')).toBeNull();
  });
});

describe('parseVersionFromSystemInfo', () => {
  it('reads a version field', () => {
    expect(parseVersionFromSystemInfo({ version: '8.5.4' })).toMatchObject({ major: 8, minor: 5 });
  });

  it('checks alternative field names across builds', () => {
    expect(parseVersionFromSystemInfo({ confluenceVersion: '7.19.6' })).toMatchObject({
      minor: 19,
    });
  });

  it.each([null, 'string', 42, {}, { version: '' }, { version: 'unknown' }])(
    'returns null for unusable input: %s',
    (input) => {
      expect(parseVersionFromSystemInfo(input)).toBeNull();
    },
  );
});

describe('parseVersionFromBody', () => {
  it('routes XML bodies to the manifest parser', () => {
    expect(parseVersionFromBody(MANIFEST)).toMatchObject({ major: 7, minor: 19, patch: 6 });
  });

  it('routes JSON bodies to the systemInfo parser', () => {
    expect(parseVersionFromBody('{"version":"8.5.4"}')).toMatchObject({ major: 8 });
  });

  it('returns null for a login page served with status 200', () => {
    expect(parseVersionFromBody(LOGIN_PAGE)).toBeNull();
  });

  it('returns null for unparseable JSON rather than throwing', () => {
    expect(parseVersionFromBody('{not json')).toBeNull();
  });

  it('tolerates leading whitespace', () => {
    expect(parseVersionFromBody(`\n\n  ${MANIFEST}`)).toMatchObject({ major: 7 });
  });
});
