import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { normaliseMarkdown, normaliseStorage } from '../../src/convert/normalise';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { Fragment } from '../../src/convert/types';

/**
 * The golden corpus (spec §8.2) — the release gate for M2.
 *
 * Two properties are asserted for every fixture:
 *
 *   1. **Idempotence, always.** `storage -> md -> storage -> md` must produce the
 *      same Markdown. A page that cannot round-trip losslessly must still
 *      convert *stably*, or repeated syncs would rewrite files forever.
 *   2. **Full fidelity where claimed.** Fixtures marked `certified` must
 *      reproduce their original storage body exactly, after normalisation.
 *
 * `expected.md` and `fragments.json` are regenerated with
 * `npm run test:bless` and reviewed by hand. They catch unintended output
 * changes; the two properties above catch actual fidelity regressions and hold
 * regardless of what the expected files say.
 */

const ROOT = 'tests/fixtures/storage';
const OPTIONS = { baseUrl: 'https://confluence.example.com', spaceKey: 'ENG' };
const CANONICAL = { defaultSpaceKey: OPTIONS.spaceKey };
const BLESS = process.env['BLESS_FIXTURES'] === '1';

interface Meta {
  readonly certified: boolean;
  readonly unparseable?: boolean;
  readonly notes?: string;
}

function readMeta(name: string): Meta {
  return JSON.parse(readFileSync(`${ROOT}/${name}/meta.json`, 'utf8')) as Meta;
}

function serialiseFragments(fragments: ReadonlyMap<string, Fragment>): string {
  return `${JSON.stringify(Array.from(fragments.values()), null, 2)}\n`;
}

const names = readdirSync(ROOT).sort();

describe('golden corpus', () => {
  it('contains fixtures', () => {
    expect(names.length).toBeGreaterThan(40);
  });

  describe.each(names)('%s', (name) => {
    const meta = readMeta(name);
    const input = readFileSync(`${ROOT}/${name}/input.xml`, 'utf8');

    if (meta.unparseable === true) {
      it('fails loudly rather than producing partial output', () => {
        const result = storageToMarkdown(input, OPTIONS);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('MALFORMED_RESPONSE');
      });
      return;
    }

    it('converts to Markdown', () => {
      const result = storageToMarkdown(input, OPTIONS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const markdownPath = `${ROOT}/${name}/expected.md`;
      const fragmentsPath = `${ROOT}/${name}/fragments.json`;

      if (BLESS) {
        writeFileSync(markdownPath, result.value.markdown);
        writeFileSync(fragmentsPath, serialiseFragments(result.value.fragments));
        return;
      }

      expect(existsSync(markdownPath), `${markdownPath} is missing — run npm run test:bless`).toBe(
        true,
      );
      expect(result.value.markdown).toBe(readFileSync(markdownPath, 'utf8'));
      expect(serialiseFragments(result.value.fragments)).toBe(readFileSync(fragmentsPath, 'utf8'));
    });

    it('converts back to storage format', () => {
      const forward = storageToMarkdown(input, OPTIONS);
      expect(forward.ok).toBe(true);
      if (!forward.ok) return;

      const back = markdownToStorage(forward.value.markdown, forward.value.fragments, OPTIONS);
      expect(back.ok, back.ok ? '' : back.error.userMessage).toBe(true);
    });

    it('is idempotent', () => {
      const first = storageToMarkdown(input, OPTIONS);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const back = markdownToStorage(first.value.markdown, first.value.fragments, OPTIONS);
      expect(back.ok).toBe(true);
      if (!back.ok) return;

      const again = storageToMarkdown(back.value, OPTIONS);
      expect(again.ok).toBe(true);
      if (!again.ok) return;

      expect(normaliseMarkdown(again.value.markdown)).toBe(normaliseMarkdown(first.value.markdown));
    });

    it(meta.certified ? 'round-trips losslessly' : 'is known not to round-trip', () => {
      const forward = storageToMarkdown(input, OPTIONS);
      expect(forward.ok).toBe(true);
      if (!forward.ok) return;

      const back = markdownToStorage(forward.value.markdown, forward.value.fragments, OPTIONS);
      const reproduced = back.ok ? normaliseStorage(back.value, CANONICAL) : null;
      const original = normaliseStorage(input, CANONICAL);

      if (meta.certified) {
        expect(reproduced).toBe(original);
      } else {
        // A fixture marked uncertified that starts passing must be re-marked,
        // or the corpus would quietly understate what the converter can do.
        expect(
          reproduced,
          `${name} now round-trips — set certified: true in its meta.json`,
        ).not.toBe(original);
      }
    });
  });
});
