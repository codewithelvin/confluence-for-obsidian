import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { readPageUrl } from '../../src/convert/storage-page-url';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * A pasted Confluence URL as an internal link (spec §6.4.16, D25, FR-4.23).
 *
 * The case is page 20840530, `TAXAZ-260 (İnterfeysin ümumi elementləri)`, linked as
 * prose from specification after specification: *"described in the Address elements
 * chapter of TAXAZ-260"*. 1 120 such links on 232 notes point at a page the vault
 * already holds, and every one of them used to leave Obsidian for the browser.
 */

const BASE = 'https://confluence.cybernet.az';
const TARGET = 'EP/Business Analysis/TAXAZ-260 (İnterfeysin ümumi elementləri)';

const MIRRORED_BY_ID = new Map([['20840530', TARGET]]);
const MIRRORED_BY_TITLE = new Map([
  ['EP TAXAZ-260 (İnterfeysin ümumi elementləri)', TARGET],
  ['EP Ana səhifə', 'EP/Ana səhifə'],
]);

const OPTIONS: ConversionOptions = {
  baseUrl: BASE,
  spaceKey: 'EP',
  resolvePageId: (pageId) => MIRRORED_BY_ID.get(pageId) ?? null,
  resolveTarget: ({ spaceKey, title }) => MIRRORED_BY_TITLE.get(`${spaceKey} ${title}`) ?? null,
  resolveVaultPath: () => null,
};

/** The anchor exactly as page 98076050 stores it — `rel` before `href`. */
function pasted(text: string, url = `${BASE}/pages/viewpage.action?pageId=20840530`): string {
  return `<a rel="nofollow" href="${url}">${text}</a>`;
}

function convert(storage: string, options: ConversionOptions = OPTIONS): string {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string, options: ConversionOptions = OPTIONS): boolean {
  const result = certify(storage, options);
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

describe('reading a page out of a Confluence URL', () => {
  it('takes the id from the viewpage form', () => {
    expect(readPageUrl(`${BASE}/pages/viewpage.action?pageId=20840530`, BASE)).toEqual({
      kind: 'id',
      pageId: '20840530',
    });
  });

  it('takes the space and title from the pretty form, decoding as it goes', () => {
    expect(readPageUrl(`${BASE}/display/EP/Ana+s%C3%A9hif%C3%A9`, BASE)).toEqual({
      kind: 'title',
      target: { spaceKey: 'EP', title: 'Ana séhifé' },
    });
  });

  it('refuses a URL carrying a fragment, which names a place and not a page', () => {
    // 56 of the mirror's 1 120. A wikilink to the page alone would land the reader at
    // the top of a long document instead of at the chapter they were sent to (O25).
    expect(readPageUrl(`${BASE}/pages/viewpage.action?pageId=20840530#Section`, BASE)).toBeNull();
  });

  it('refuses another host, and anything that is not a page address', () => {
    expect(readPageUrl('https://example.com/pages/viewpage.action?pageId=1', BASE)).toBeNull();
    expect(readPageUrl(`${BASE}/download/attachments/1/a.png`, BASE)).toBeNull();
    expect(readPageUrl(`${BASE}/display/EP`, BASE)).toBeNull();
  });

  it('survives a malformed escape rather than throwing', () => {
    // The mirror holds `/display/C/%5CUsers%5CMAX%5C…`, a Windows path someone dropped
    // into the editor. A stray `%` must not take the whole page down.
    expect(readPageUrl(`${BASE}/display/EP/100%`, BASE)).toBeNull();
  });
});

describe('a pasted link to a mirrored page', () => {
  it('becomes a wikilink with the anchor carried beside it', () => {
    const storage = `<p>Təsviri ${pasted('TAXAZ-260')} sənədində</p>`;
    expect(convert(storage)).toBe(`Təsviri [[${TARGET}|TAXAZ-260]]<!--cf-a:cfb-0001--> sənədində`);
  });

  it('drops the label where it already says the page name', () => {
    const storage = `<p>${pasted('TAXAZ-260 (İnterfeysin ümumi elementləri)')}</p>`;
    expect(convert(storage)).toBe(`[[${TARGET}]]<!--cf-a:cfb-0001-->`);
  });

  it('works for the pretty URL form too', () => {
    // Encoded the way Confluence does it, and the way `pageUrl` does: percent-encoded
    // with a space as `+`. Built rather than written out, because hand-encoding
    // Azerbaijani is how this test was wrong twice.
    const url = `${BASE}/display/EP/${encodeURIComponent('Ana səhifə').replace(/%20/g, '+')}`;
    expect(convert(`<p>${pasted('Ana səhifə', url)}</p>`)).toBe(
      '[[EP/Ana səhifə]]<!--cf-a:cfb-0001-->',
    );
  });

  it('keeps the page certified, whatever order the attributes came in', () => {
    // Five orders across the mirror's 816 anchors. The element rides in the fragment
    // for exactly this reason — a reverse pass that rebuilt it would pick one.
    for (const tag of [
      `<a href="${BASE}/pages/viewpage.action?pageId=20840530">T</a>`,
      `<a rel="nofollow" href="${BASE}/pages/viewpage.action?pageId=20840530">T</a>`,
      `<a href="${BASE}/pages/viewpage.action?pageId=20840530" rel="nofollow">T</a>`,
      `<a style="color: rgb(0,0,255)" href="${BASE}/pages/viewpage.action?pageId=20840530">T</a>`,
      `<a href="${BASE}/pages/viewpage.action?pageId=20840530" style="color: rgb(0,0,255)">T</a>`,
    ]) {
      expect(certified(`<p>${tag}</p>`)).toBe(true);
    }
  });

  it('hands Confluence back the identical anchor', () => {
    const storage = `<p>Təsviri ${pasted('TAXAZ-260')} sənədində</p>`;
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('survives two of them in one paragraph', () => {
    const storage = `<p>${pasted('bir')} və ${pasted('iki')}</p>`;
    const markdown = convert(storage);

    expect(markdown).toContain('cf-a:cfb-0001');
    expect(markdown).toContain('cf-a:cfb-0002');
    expect(push(markdown, storage)).toBe(storage);
  });

  it('does not disturb an image embed in the same paragraph', () => {
    // The two carriers replace different kinds of bracket construct. Taking whichever
    // came last regardless would put the anchor where the picture belongs.
    const options: ConversionOptions = { ...OPTIONS, resolveAttachment: () => 'EP/_att/a.png' };
    // `ac:thumbnail` has no embed form, so the image needs a carrier of its own — a
    // plain `ac:image` round-trips from the embed alone and takes no fragment.
    const storage =
      `<p>${pasted('TAXAZ-260')} <ac:image ac:thumbnail="true">` +
      '<ri:attachment ri:filename="a.png"/></ac:image></p>';

    const markdown = convert(storage, options);
    expect(markdown).toContain('cf-a:cfb-0001');
    expect(markdown).toContain('cf-img:cfb-0002');

    const forward = storageToMarkdown(storage, options);
    if (!forward.ok) throw new Error('forward failed');
    const back = markdownToStorage(markdown, forward.value.fragments, options);
    if (!back.ok) throw new Error(back.error.userMessage);
    expect(back.value).toBe(storage);
  });
});

describe('a pasted link this cannot turn inwards', () => {
  it('stays a browser link when the page is not mirrored', () => {
    const url = `${BASE}/pages/viewpage.action?pageId=999`;
    const storage = `<p><a href="${url}">Elsewhere</a></p>`;

    expect(convert(storage)).toContain(url);
    expect(convert(storage)).not.toContain('cf-a:');
    expect(certified(storage)).toBe(true);
  });

  it('stays a browser link when it carries a fragment', () => {
    const url = `${BASE}/pages/viewpage.action?pageId=20840530#Address`;
    const storage = `<p><a href="${url}">Chapter</a></p>`;

    expect(convert(storage)).not.toContain('cf-a:');
    expect(certified(storage)).toBe(true);
  });

  it('stays as it is when the anchor wraps markup a label cannot hold', () => {
    const storage = `<p><a href="${BASE}/pages/viewpage.action?pageId=20840530"><strong>T</strong></a></p>`;

    expect(convert(storage)).not.toContain('cf-a:');
    expect(certified(storage)).toBe(true);
  });

  it('stays as it is when the text would break the wikilink', () => {
    const storage = `<p>${pasted('a | b')}</p>`;
    expect(convert(storage)).not.toContain('cf-a:');
    expect(certified(storage)).toBe(true);
  });

  it('stays as it is when the anchor has no text at all', () => {
    const storage = `<p>${pasted('')}</p>`;
    expect(convert(storage)).not.toContain('cf-a:');
  });
});

describe('an edited note holding a turned-inwards link', () => {
  it('puts the anchor back when the user deleted the wikilink and left the marker', () => {
    // The same guarantee `cf-img` gives a deleted picture: an edit that only looked
    // like a deletion does not silently drop the link from the page.
    const storage = `<p>Təsviri ${pasted('TAXAZ-260')} sənədində</p>`;
    expect(push('Təsviri <!--cf-a:cfb-0001--> sənədində', storage)).toBe(storage);
  });

  it('puts it back even where the user typed over the link', () => {
    // An inline carrier has no failure mode here — whatever the words around it, the
    // anchor is recovered rather than lost, and the push diff shows what changed.
    const storage = `<p>${pasted('TAXAZ-260')}</p>`;
    expect(push('my own words<!--cf-a:cfb-0001-->', storage)).toContain(
      'href="https://confluence.cybernet.az/pages/viewpage.action?pageId=20840530"',
    );
  });

  it('keeps the link when the user rewrote only its label', () => {
    const storage = `<p>${pasted('TAXAZ-260')}</p>`;
    expect(push(`[[${TARGET}|my wording]]<!--cf-a:cfb-0001-->`, storage)).toBe(storage);
  });
});
