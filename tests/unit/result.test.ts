import { describe, expect, it } from 'vitest';
import {
  collectResults,
  err,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  unwrapOr,
} from '../../src/util/result';

describe('Result', () => {
  it('constructs success and failure values', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });

  it('narrows with isOk and isErr', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err('x'))).toBe(false);
    expect(isErr(err('x'))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });

  it('treats a falsy success value as a success', () => {
    // Guards against an `if (result.value)` style regression.
    expect(isOk(ok(0))).toBe(true);
    expect(unwrapOr(ok(0), 99)).toBe(0);
    expect(unwrapOr(ok(''), 'fallback')).toBe('');
  });

  it('falls back only on error', () => {
    expect(unwrapOr(ok(5), 99)).toBe(5);
    expect(unwrapOr(err<string>('boom'), 99)).toBe(99);
  });

  it('maps the success value and leaves errors untouched', () => {
    expect(mapResult(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
    expect(mapResult(err<string>('boom'), (n: number) => n * 3)).toEqual({
      ok: false,
      error: 'boom',
    });
  });

  it('maps the error and leaves success untouched', () => {
    expect(mapError(err('boom'), (e) => `${e}!`)).toEqual({ ok: false, error: 'boom!' });
    expect(mapError(ok(1), (e: string) => `${e}!`)).toEqual({ ok: true, value: 1 });
  });

  describe('collectResults', () => {
    it('collects all values when every result succeeds', () => {
      expect(collectResults([ok(1), ok(2), ok(3)])).toEqual({ ok: true, value: [1, 2, 3] });
    });

    it('short-circuits on the first error', () => {
      const results = [ok(1), err<string>('first'), err<string>('second')];
      expect(collectResults(results)).toEqual({ ok: false, error: 'first' });
    });

    it('returns an empty list for no results', () => {
      expect(collectResults([])).toEqual({ ok: true, value: [] });
    });
  });
});
