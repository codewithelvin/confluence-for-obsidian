import { describe, expect, it } from 'vitest';
import {
  MAX_ABSOLUTE_PATH,
  disambiguate,
  fitToBudget,
  idSuffix,
  isUnfixablyLong,
  sanitiseSegment,
  segmentBudget,
} from '../../src/vault/filename-sanitiser';

describe('sanitiseSegment', () => {
  it('leaves an ordinary title untouched', () => {
    expect(sanitiseSegment('Data Model')).toBe('Data Model');
    expect(sanitiseSegment('TAXAZ-150-01 Autentifikasiya')).toBe('TAXAZ-150-01 Autentifikasiya');
  });

  it('keeps non-ASCII letters', () => {
    // Azerbaijani, Russian and emoji all appear in the client's pages.
    expect(sanitiseSegment('Vergi ödəyicisinin profili')).toBe('Vergi ödəyicisinin profili');
    expect(sanitiseSegment('Просмотреть профиль')).toBe('Просмотреть профиль');
  });

  it('replaces characters Windows forbids', () => {
    expect(sanitiseSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('replaces control characters', () => {
    expect(sanitiseSegment(`a${String.fromCharCode(1)}b`)).toBe('a-b');
    expect(sanitiseSegment(`a${String.fromCharCode(31)}b`)).toBe('a-b');
  });

  it('collapses runs created by replacement', () => {
    expect(sanitiseSegment('a///b')).toBe('a-b');
  });

  it('strips trailing dots and spaces, which Windows silently drops', () => {
    expect(sanitiseSegment('Report.')).toBe('Report');
    expect(sanitiseSegment('Report   ')).toBe('Report');
    expect(sanitiseSegment('Report. . .')).toBe('Report');
  });

  it('keeps interior dots', () => {
    expect(sanitiseSegment('v1.2.3 release')).toBe('v1.2.3 release');
  });

  it('falls back for a title with nothing usable left', () => {
    expect(sanitiseSegment('')).toBe('Untitled');
    expect(sanitiseSegment('   ')).toBe('Untitled');
    expect(sanitiseSegment('...')).toBe('Untitled');
  });

  it('escapes Windows device names', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      expect(sanitiseSegment(name)).toBe(`${name}_`);
    }
  });

  it('escapes a device name carrying an extension', () => {
    // `CON.md` is as unusable as `CON` on Windows.
    expect(sanitiseSegment('CON.md')).toBe('CON.md_');
    expect(sanitiseSegment('nul.txt')).toBe('nul.txt_');
  });

  it('leaves names that merely start with a device name', () => {
    expect(sanitiseSegment('CONTENTS')).toBe('CONTENTS');
    expect(sanitiseSegment('COM10')).toBe('COM10');
  });

  it('is deterministic', () => {
    const title = 'A/B: c*d ';
    expect(sanitiseSegment(title)).toBe(sanitiseSegment(title));
  });
});

describe('idSuffix', () => {
  it('takes the last six characters of the page id', () => {
    expect(idSuffix('8061060')).toBe('~061060');
    expect(idSuffix('12')).toBe('~12');
  });
});

describe('disambiguate', () => {
  it('leaves a name that no sibling has taken', () => {
    expect(disambiguate('Data Model', '8061060', new Set())).toBe('Data Model');
  });

  it('appends the page id when a sibling already used the name', () => {
    const taken = new Set(['data model']);
    expect(disambiguate('Data Model', '8061060', taken)).toBe('Data Model ~061060');
  });

  it('compares case-insensitively, since Windows does', () => {
    expect(disambiguate('DATA MODEL', '8061060', new Set(['data model']))).toContain('~061060');
  });
});

describe('segmentBudget', () => {
  it('charges a leaf name once', () => {
    // `<dir>/<segment>.md`
    expect(segmentBudget(100, 1)).toBe(MAX_ABSOLUTE_PATH - 100 - 1 - 3);
  });

  it('charges a folder-note name twice', () => {
    // `<dir>/<segment>/<segment>.md` — decision D9 spends the name twice, which
    // is the whole of risk R2.
    const budget = segmentBudget(100, 2);
    expect(100 + 1 + budget + 1 + budget + 3).toBeLessThanOrEqual(MAX_ABSOLUTE_PATH);
    expect(budget).toBeLessThan(segmentBudget(100, 1));
  });

  it('goes negative once the parent directory alone exhausts the budget', () => {
    expect(segmentBudget(MAX_ABSOLUTE_PATH, 1)).toBeLessThan(0);
  });
});

describe('fitToBudget', () => {
  it('leaves a segment that already fits', () => {
    expect(fitToBudget('Short', '8061060', 20)).toBe('Short');
  });

  it('truncates a segment that would overflow, keeping the id', () => {
    const result = fitToBudget('x'.repeat(300), '8061060', 40);

    expect(result.length).toBe(40);
    expect(result.endsWith('~061060')).toBe(true);
  });

  it('produces a stable result for the same inputs', () => {
    const long = 'y'.repeat(300);
    expect(fitToBudget(long, '8061060', 40)).toBe(fitToBudget(long, '8061060', 40));
  });

  it('does not leave a trailing space before the suffix', () => {
    const long = `${'z'.repeat(100)} ${'z'.repeat(200)}`;
    expect(fitToBudget(long, '8061060', 102)).not.toContain(' ~');
  });

  it('falls back to the id alone when there is no room at all', () => {
    expect(fitToBudget('anything', '8061060', 3)).toBe('~061060');
  });
});

describe('isUnfixablyLong', () => {
  it('is false while a shortened name could still fit', () => {
    expect(isUnfixablyLong(20, '8061060')).toBe(false);
  });

  it('is true once not even the page id fits', () => {
    expect(isUnfixablyLong(3, '8061060')).toBe(true);
    expect(isUnfixablyLong(-5, '8061060')).toBe(true);
  });
});
