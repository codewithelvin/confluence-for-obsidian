import { describe, expect, it } from 'vitest';
import { newId } from '../../src/util/id';
import { isSafeStorage, resolveSafeStorage } from '../../src/auth/credential-store';
import { asArray, asBoolean, asFiniteNumber, readPath } from '../../src/util/guards';

describe('newId', () => {
  it('produces a non-empty identifier', () => {
    expect(newId().length).toBeGreaterThan(8);
  });

  it('produces a distinct identifier each time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });
});

describe('isSafeStorage', () => {
  const complete = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  };

  it('accepts an object exposing all three methods', () => {
    expect(isSafeStorage(complete)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'safeStorage'],
    ['an empty object', {}],
  ])('rejects %s', (_label, candidate) => {
    expect(isSafeStorage(candidate)).toBe(false);
  });

  it.each(['isEncryptionAvailable', 'encryptString', 'decryptString'])(
    'rejects an object missing %s',
    (missing) => {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[missing];
      expect(isSafeStorage(partial)).toBe(false);
    },
  );

  it('rejects an object whose members are not functions', () => {
    expect(isSafeStorage({ ...complete, encryptString: 'not a function' })).toBe(false);
  });
});

describe('resolveSafeStorage', () => {
  it('returns null rather than throwing when Electron is unreachable', () => {
    // Exactly the situation under test, and the situation on Linux without a
    // keyring: absence must be a supported state, not a crash.
    expect(resolveSafeStorage()).toBeNull();
  });
});

describe('guards', () => {
  it('reads a nested path', () => {
    expect(readPath({ _links: { next: '/x' } }, '_links', 'next')).toBe('/x');
  });

  it('returns undefined as soon as a path segment is missing', () => {
    expect(readPath({ _links: {} }, '_links', 'next')).toBeUndefined();
    expect(readPath({}, 'a', 'b', 'c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath({ a: 'string' }, 'a', 'b')).toBeUndefined();
  });

  it('returns the source when given no path', () => {
    expect(readPath('value')).toBe('value');
  });

  it('narrows arrays and rejects other values', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({})).toBeNull();
    expect(asArray('ab')).toBeNull();
  });

  it('narrows booleans strictly', () => {
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean('true')).toBeNull();
    expect(asBoolean(0)).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(asFiniteNumber(1.5)).toBe(1.5);
    expect(asFiniteNumber(Number.NaN)).toBeNull();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber('5')).toBeNull();
  });
});
