import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Emphasis with nothing but punctuation in it (spec §6.4.2).
 *
 * 784 of these in the mirror and the third largest cause of a grey pill there: 210
 * bold full stops, 202 bold `№`, 98 bold hyphens, 25 italic semicolons. Markdown
 * cannot express any of them — mid-sentence `word**.**` is not left-flanking, so the
 * asterisks stay literal — but raw inline HTML can, and needs no fragment.
 */

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
};

function convert(storage: string): string {
  const result = storageToMarkdown(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

function push(markdown: string, storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('emphasis holding only punctuation', () => {
  it('is written as its own tags rather than hidden behind a pill', () => {
    expect(convert('<p>Son cümlə<strong>.</strong></p>')).toBe('Son cümlə<strong>.</strong>');
  });

  it('covers the shapes the mirror actually holds', () => {
    for (const [storage, expected] of [
      ['<p><strong>№</strong> 5</p>', '<strong>№</strong> 5'],
      ['<p>a<strong>-</strong>b</p>', 'a<strong>-</strong>b'],
      ['<p>bir<em>;</em></p>', 'bir<em>;</em>'],
      ['<p><strong>«</strong>ad<strong>»</strong></p>', '<strong>«</strong>ad<strong>»</strong>'],
      ['<p>x<s>№</s></p>', 'x<s>№</s>'],
    ] as const) {
      expect(convert(storage)).toBe(expected);
    }
  });

  it('keeps the page certified', () => {
    expect(certified('<p>Son cümlə<strong>.</strong></p>')).toBe(true);
    expect(certified('<p><strong>№</strong> 5</p>')).toBe(true);
    expect(certified('<p>bir<em>;</em></p>')).toBe(true);
  });

  it('hands Confluence back the identical markup', () => {
    const storage = '<p>Bu hissə<strong>.</strong> və <em>,</em> arasında</p>';
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('still converts emphasis that does hold a word', () => {
    expect(convert('<p><strong>Ərizələr</strong></p>')).toBe('**Ərizələr**');
  });

  it('round-trips a character that is itself markup', () => {
    // The `<` goes into the note bare — a lone `<` is literal text in CommonMark, so
    // the tags around it still parse and the entity comes back on the way out.
    const storage = '<p>a<strong>&lt;</strong>b</p>';
    expect(convert(storage)).toBe('a<strong><</strong>b');
    expect(push(convert(storage), storage)).toBe(storage);
    expect(certified(storage)).toBe(true);
  });
});

describe('emphasis holding only whitespace', () => {
  it('stays a widget, because a lost space would cost the page its push', () => {
    // 6 of the mirror's 784. `remark-stringify` has nowhere reliable to keep a run
    // of spaces inside inline HTML.
    const markdown = convert('<p>a<s>  </s>b</p>');
    expect(markdown).toContain('{cf:cfb-0001}');
  });

  it('keeps that page certified too', () => {
    expect(certified('<p>a<s>  </s>b</p>')).toBe(true);
  });
});
