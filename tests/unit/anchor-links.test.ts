import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { anchorLabel, readAnchorUrl } from '../../src/convert/storage-anchor';
import { parseStorage } from '../../src/convert/storage-parser';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Anchor links (spec §6.4.15, D24, FR-4.22).
 *
 * Every shape here is one the mirror holds. The Word-bookmark contents entry
 * (`_Toc42611092`, 3 274 of them), the heading-title anchor space EP's authors write
 * by hand (`Hesabın açılması`), the bodyless one that renders as its own name, and
 * the cross-page form carrying an `ri:content-entity` — 1 262 of those, every single
 * target outside this mirror.
 */

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
};

/** The contents entry of page 11731084, whose body is the rich form. */
function richBody(anchor: string, text: string): string {
  return `<ac:link ac:anchor="${anchor}"><ac:link-body>${text}</ac:link-body></ac:link>`;
}

/** The same link written the other way, which Confluence renders identically. */
function plainBody(anchor: string, text: string): string {
  return (
    `<ac:link ac:anchor="${anchor}">` +
    `<ac:plain-text-link-body>${text}</ac:plain-text-link-body></ac:link>`
  );
}

/** The cross-page form: an anchor on a page named by content id. */
function crossPage(anchor: string, id: string, text: string): string {
  return (
    `<ac:link ac:anchor="${anchor}"><ri:content-entity ri:content-id="${id}"/>` +
    `<ac:plain-text-link-body>${text}</ac:plain-text-link-body></ac:link>`
  );
}

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

describe('a link to an anchor on the same page', () => {
  it('shows its text as a Markdown link to the fragment', () => {
    expect(convert(`<p>${plainBody('_Toc42611092', '1. Список изменений')}</p>`)).toBe(
      '[1. Список изменений](#_Toc42611092)',
    );
  });

  it('reads the rich body form the same way, since Confluence renders them alike', () => {
    // 2 126 of the mirror's 3 561 are written this way, and every one of them used to
    // take its own words into the fragment with it.
    expect(convert(`<p>${richBody('_Toc15423860', '1. History')}</p>`)).toBe(
      '[1. History](#_Toc15423860)',
    );
  });

  it('writes an anchor holding spaces in the angle-bracket form, unencoded', () => {
    // Readability is the point: these notes are read and edited by hand, and
    // percent-encoding Azerbaijani text would make a contents page unreadable.
    expect(convert(`<p>${plainBody('Hesabın açılması', 'Hesabın açılması bölməsi')}</p>`)).toBe(
      '[Hesabın açılması bölməsi](<#Hesabın açılması>)',
    );
  });

  it('shows a bodyless link as the anchor name, which is what Confluence draws', () => {
    expect(convert('<p><ac:link ac:anchor="Hesabın açılması"/></p>')).toBe(
      '[Hesabın açılması](<#Hesabın açılması>)',
    );
  });

  it('keeps the page certified in every one of those forms', () => {
    expect(certified(`<p>${plainBody('_Toc42611092', '1. Список изменений')}</p>`)).toBe(true);
    expect(certified(`<p>${richBody('_Toc15423860', '1. History')}</p>`)).toBe(true);
    expect(certified('<p><ac:link ac:anchor="Hesabın açılması"/></p>')).toBe(true);
  });

  it('hands Confluence back the plain-text body form', () => {
    const storage = `<p>${plainBody('_Toc42611092', '1. Список изменений')}</p>`;
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('hands back a bodyless link when the text is the anchor name', () => {
    const storage = '<p><ac:link ac:anchor="Hesabın açılması"/></p>';
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('drops a trailing space Confluence stored inside the text', () => {
    // `<ac:link-body>1. History </ac:link-body>` is common. Inside a link the space
    // is invisible but for a hair of underline, and §6.4.5 trims both sides of the
    // comparison so the page still certifies.
    const storage = `<p>${richBody('_Toc15423860', '1. History ')}</p>`;
    expect(convert(storage)).toBe('[1. History](#_Toc15423860)');
    expect(certified(storage)).toBe(true);
  });

  it('survives a whole contents list', () => {
    const entries = ['1. Список изменений', '2. Введение', '3. Требования'];
    const storage = `<ul>${entries
      .map((text, index) => `<li>${plainBody(`_Toc4261109${String(index)}`, text)}</li>`)
      .join('')}</ul>`;

    const markdown = convert(storage);
    for (const text of entries) expect(markdown).toContain(`[${text}](#_Toc4261109`);
    expect(markdown).not.toContain('{cf:');
    expect(push(markdown, storage)).toBe(storage);
  });
});

describe('an anchor link that has to stay a widget', () => {
  it('stays one when the anchor is on another page', () => {
    // All 1 262 of the mirror's cross-page anchors name a page it does not hold, so
    // there is no vault target to point at (§16 O25).
    const markdown = convert(`<p>${crossPage('_Toc15423860', '11075607', '1. History')}</p>`);
    expect(markdown).toContain('{cf:cfb-0001}');
  });

  it('names the link in the widget instead of naming an XML element', () => {
    const element = parseStorage(crossPage('_Toc15423860', '11075607', '1. History'));
    if (!element.ok) throw new Error('unparsed');

    const link = element.value.getElementsByTagName('ac:link')[0];
    expect(anchorLabel(link as Element)).toBe('link to “1. History” on another page');
  });

  it('names a same-page anchor link it could not convert', () => {
    const element = parseStorage(
      '<ac:link ac:anchor="X" ac:card-appearance="inline">' +
        '<ac:plain-text-link-body>Bax</ac:plain-text-link-body></ac:link>',
    );
    if (!element.ok) throw new Error('unparsed');

    const link = element.value.getElementsByTagName('ac:link')[0];
    expect(anchorLabel(link as Element)).toBe('anchor link — Bax');
  });

  it('stays one when the body carries markup a link text cannot hold', () => {
    const body =
      '<ac:link-body><span style="color: rgb(0,0,255)"><span style="text-decoration: ' +
      'underline">1.</span></span></ac:link-body>';
    const markdown = convert(`<p><ac:link ac:anchor="_heading=h.2s8eyo1">${body}</ac:link></p>`);

    expect(markdown).toContain('{cf:cfb-0001}');
  });

  it('stays one when the link carries a second attribute', () => {
    const storage =
      '<p><ac:link ac:anchor="X" ac:card-appearance="inline">' +
      '<ac:plain-text-link-body>Bax</ac:plain-text-link-body></ac:link></p>';
    expect(convert(storage)).toContain('{cf:cfb-0001}');
    expect(certified(storage)).toBe(true);
  });

  it('stays one when the text is empty, since there would be nothing to click', () => {
    expect(convert(`<p>${plainBody('_Toc1', '  ')}</p>`)).toContain('{cf:cfb-0001}');
  });
});

describe('a raw anchor tag pointing at a fragment', () => {
  it('is preserved as its own tags, so the two forms stay distinguishable', () => {
    // Both render as the same Markdown link. If this became one too, the reverse pass
    // would turn it into an `ac:link` and the page could never be pushed again.
    const storage = '<p><a href="#_Toc42611092">1. History</a></p>';
    const markdown = convert(storage);

    expect(markdown).toContain('<a href="#_Toc42611092">');
    expect(certified(storage)).toBe(true);
    expect(push(markdown, storage)).toBe(storage);
  });

  it('still converts an ordinary external link', () => {
    const storage = '<p><a href="https://example.com/x">docs</a></p>';
    expect(convert(storage)).toBe('[docs](https://example.com/x)');
  });
});

describe('the fragment-URL grammar', () => {
  it('reads an anchor out of a fragment destination', () => {
    expect(readAnchorUrl('#_Toc42611092')).toBe('_Toc42611092');
    expect(readAnchorUrl('#Hesabın açılması')).toBe('Hesabın açılması');
  });

  it('rejects anything that is not one', () => {
    expect(readAnchorUrl('#')).toBeNull();
    expect(readAnchorUrl('')).toBeNull();
    expect(readAnchorUrl('https://example.com/#x')).toBeNull();
  });
});

describe('an edited note holding an anchor link', () => {
  it('keeps the link when the user rewrote its text', () => {
    const storage = `<p>${plainBody('_Toc42611092', 'Old wording')}</p>`;
    expect(push('[New wording](#_Toc42611092)', storage)).toContain(
      '<ac:plain-text-link-body>New wording</ac:plain-text-link-body>',
    );
  });

  it('writes a plain anchor tag when the user put markup inside the link text', () => {
    // The link form cannot carry it, so it falls through rather than being guessed at
    // — and push verification then stops the page.
    const storage = `<p>${plainBody('_Toc42611092', 'text')}</p>`;
    expect(push('[**bold**](#_Toc42611092)', storage)).toContain('<a href="#_Toc42611092">');
  });
});
