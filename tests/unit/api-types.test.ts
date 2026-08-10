import { describe, expect, it } from 'vitest';
import { parsePaged, parseSpace, parseUser } from '../../src/api/api-types';

describe('parseUser', () => {
  it('parses a well-formed user', () => {
    const result = parseUser({ username: 'e.huseynov', displayName: 'Elvin Huseynov' });
    expect(result).toEqual({
      ok: true,
      value: { username: 'e.huseynov', displayName: 'Elvin Huseynov' },
    });
  });

  it('falls back to userKey when username is absent', () => {
    // Some Data Center builds populate only userKey.
    const result = parseUser({ userKey: 'ff8081...', displayName: 'Elvin' });
    expect(result.ok && result.value.username).toBe('ff8081...');
  });

  it('falls back to the username when no display name is given', () => {
    const result = parseUser({ username: 'e.huseynov' });
    expect(result.ok && result.value.displayName).toBe('e.huseynov');
  });

  it('rejects a response with no identity at all', () => {
    const result = parseUser({ displayName: 'Elvin' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('MALFORMED_RESPONSE');
  });

  it.each([null, undefined, 'a string', 42, []])('rejects non-object input: %s', (input) => {
    expect(parseUser(input).ok).toBe(false);
  });

  it('explains the likely cause in the error message', () => {
    const result = parseUser('<html>login</html>');
    expect(!result.ok && result.error.userMessage).toContain('login page');
  });
});

describe('parseSpace', () => {
  it('parses a well-formed space', () => {
    const result = parseSpace({ key: 'ENG', name: 'Engineering', type: 'global' });
    expect(result).toEqual({
      ok: true,
      value: { key: 'ENG', name: 'Engineering', type: 'global' },
    });
  });

  it('falls back to the key when the name is missing', () => {
    expect(parseSpace({ key: 'ENG' }).ok && parseSpace({ key: 'ENG' })).toMatchObject({
      value: { name: 'ENG' },
    });
  });

  it('defaults the type to global', () => {
    const result = parseSpace({ key: 'ENG' });
    expect(result.ok && result.value.type).toBe('global');
  });

  it('rejects a space with no key', () => {
    expect(parseSpace({ name: 'Engineering' }).ok).toBe(false);
    expect(parseSpace({ key: '  ' }).ok).toBe(false);
  });
});

describe('parsePaged', () => {
  it('parses a well-formed page', () => {
    const result = parsePaged(
      { results: [{ key: 'ENG' }, { key: 'OPS' }], start: 0, limit: 25, size: 2 },
      parseSpace,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    expect(result.value.start).toBe(0);
    expect(result.value.limit).toBe(25);
    expect(result.value.nextPath).toBeNull();
  });

  it('drops malformed entries but keeps the page', () => {
    // One unusable space must not make the whole space browser fail.
    const result = parsePaged({ results: [{ key: 'ENG' }, { name: 'broken' }, null] }, parseSpace);
    expect(result.ok && result.value.results).toHaveLength(1);
  });

  it('reads the next-page link when present', () => {
    const result = parsePaged(
      { results: [], _links: { next: '/rest/api/space?limit=25&start=25' } },
      parseSpace,
    );
    expect(result.ok && result.value.nextPath).toBe('/rest/api/space?limit=25&start=25');
  });

  it('rejects an envelope with no results array', () => {
    expect(parsePaged({ start: 0 }, parseSpace).ok).toBe(false);
    expect(parsePaged({ results: 'nope' }, parseSpace).ok).toBe(false);
  });

  it.each([null, 'a string', 42])('rejects non-object envelopes: %s', (input) => {
    expect(parsePaged(input, parseSpace).ok).toBe(false);
  });

  it('defaults absent counters from the parsed results', () => {
    const result = parsePaged({ results: [{ key: 'ENG' }] }, parseSpace);
    expect(result.ok && result.value.size).toBe(1);
    expect(result.ok && result.value.limit).toBe(1);
  });
});
