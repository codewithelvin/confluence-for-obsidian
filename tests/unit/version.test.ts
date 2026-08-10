import { describe, expect, it } from 'vitest';
import {
  MINIMUM_SUPPORTED_VERSION,
  compareVersions,
  meetsMinimumVersion,
  parseVersion,
} from '../../src/util/version';

describe('parseVersion', () => {
  it('parses a full version', () => {
    expect(parseVersion('7.19.6')).toMatchObject({ major: 7, minor: 19, patch: 6, raw: '7.19.6' });
  });

  it('defaults missing segments to zero', () => {
    expect(parseVersion('8')).toMatchObject({ major: 8, minor: 0, patch: 0 });
    expect(parseVersion('8.5')).toMatchObject({ major: 8, minor: 5, patch: 0 });
  });

  it('tolerates surrounding text and suffixes', () => {
    expect(parseVersion('  7.19.6-EAP01 ')).toMatchObject({ major: 7, minor: 19, patch: 6 });
    expect(parseVersion('Confluence 9.2.1')).toMatchObject({ major: 9, minor: 2, patch: 1 });
  });

  it('returns null when no number is present', () => {
    expect(parseVersion('unknown')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  const v = (raw: string) => {
    const parsed = parseVersion(raw);
    if (parsed === null) throw new Error(`unparseable: ${raw}`);
    return parsed;
  };

  it('compares minor versions numerically, not lexicographically', () => {
    // The regression this guards: "7.19.6" < "7.9" as strings, but 7.19.6 is
    // the newer release. The client instance is 7.19.6.
    expect(compareVersions(v('7.19.6'), v('7.9'))).toBeGreaterThan(0);
  });

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(v('8.0.0'), v('7.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('7.9.1'), v('7.9.0'))).toBeGreaterThan(0);
    expect(compareVersions(v('7.9.0'), v('7.9.0'))).toBe(0);
    expect(compareVersions(v('6.15.0'), v('7.0.0'))).toBeLessThan(0);
  });
});

describe('meetsMinimumVersion', () => {
  it('requires 7.9 or later for Personal Access Tokens', () => {
    expect(MINIMUM_SUPPORTED_VERSION.raw).toBe('7.9');
  });

  it('accepts the client instance version', () => {
    const version = parseVersion('7.19.6');
    expect(version).not.toBeNull();
    expect(meetsMinimumVersion(version!)).toBe(true);
  });

  it('accepts exactly the minimum', () => {
    expect(meetsMinimumVersion(parseVersion('7.9.0')!)).toBe(true);
  });

  it('rejects versions below the PAT floor', () => {
    expect(meetsMinimumVersion(parseVersion('7.8.9')!)).toBe(false);
    expect(meetsMinimumVersion(parseVersion('6.15.0')!)).toBe(false);
  });
});
