import { describe, expect, it } from 'vitest';
import { certify } from '../../src/convert/round-trip-verifier';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import { attachmentUrl } from '../../src/convert/table-media';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Pictures and file links inside a preserved table (spec §6.4.10, D19, FR-4.16,
 * FR-4.17).
 *
 * The shapes are the ones page 146743218 actually holds — the `Data Dictionary`
 * tables whose 23 rows of specification were invisible behind a 32-pixel
 * screenshot of a button.
 *
 * Two things are asserted throughout, and they are separate: that the picture
 * *appears* in the note, and that the original `ac:image` comes back **exactly**.
 * The second is what keeps the page pushable, and it is asserted against the
 * stored markup rather than through `normalise` on both sides — `mergeAdjacentInline`
 * once deleted a space and still certified, so a rule that runs on both sides of
 * the comparison proves nothing.
 */

const MOUNT = 'EP/_attachments/146743218';

const DOWNLOADED = new Map([
  ['Secondary button.png', `${MOUNT}/Secondary button.png`],
  ['primary button.png', `${MOUNT}/primary button.png`],
  ['Toplu FİN.xlsx', `${MOUNT}/Toplu FİN.xlsx`],
]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
  resolveAttachment: (filename: string): string | null => DOWNLOADED.get(filename) ?? null,
};

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

/** What a push would send for a note converted from this storage and left alone. */
function pushed(storage: string, markdown?: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(
    markdown ?? forward.value.markdown,
    forward.value.fragments,
    OPTIONS,
  );
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

/**
 * A table GFM cannot express, so that the HTML projection is what runs.
 *
 * `rowspan` is the reason page 146743218's tables are preserved at all, and using
 * the real reason keeps these tests testing the projection rather than a shape
 * that would have become a GFM table anyway.
 */
function preservedTable(cell: string): string {
  return (
    '<table><tbody>' +
    '<tr><th>Sütunun adı</th><th>Göstərici</th></tr>' +
    `<tr><td rowspan="2">Yüklə</td><td>${cell}</td></tr>` +
    '<tr><td>ikinci sətir</td></tr>' +
    '</tbody></table>'
  );
}

/** The image exactly as the page stores it: a thumbnail with a lone height. */
const BUTTON =
  '<ac:image ac:thumbnail="true" ac:height="32">' +
  '<ri:attachment ri:filename="Secondary button.png"/>' +
  '</ac:image>';

/** The bodyless link shape — no text at all, so Confluence draws the file name. */
const SPREADSHEET = '<ac:link><ri:attachment ri:filename="Toplu FİN.xlsx"/></ac:link>';

describe('an image inside a preserved table', () => {
  it('is written as an <img> the reader can see, not hidden behind a placeholder', () => {
    const markdown = convert(preservedTable(BUTTON));

    expect(markdown).toContain('<img src="EP/_attachments/146743218/Secondary%20button.png"');
    expect(markdown).not.toContain('confluence-block');
  });

  it('releases the whole table, which was opaque for this one reason', () => {
    expect(convert(preservedTable(BUTTON))).toContain('Sütunun adı');
  });

  it('keeps a lone height as a height, which the prose embed cannot', () => {
    // FR-8.2 has to show `ac:height` as a *width*, because Obsidian's embed syntax
    // sizes by width and has nowhere else to put it. HTML has both attributes, so
    // the projection is the more faithful of the two.
    expect(convert(preservedTable(BUTTON))).toContain('height="32"');
  });

  it('carries the original element, so nothing about it is guessed', () => {
    expect(convert(preservedTable(BUTTON))).toContain('<!--cf-tbl:cfb-0001-->');
  });

  it('certifies, so the page stays pushable', () => {
    expect(certified(preservedTable(BUTTON))).toBe(true);
  });

  it('gives Confluence back the element itself, attribute for attribute', () => {
    // Asserted against the stored markup, not through `certify` alone: a rule that
    // runs on both sides of the comparison can agree with itself. `ac:thumbnail` is
    // drawn by neither side, so only the fragment could have carried it back.
    const storage = preservedTable(BUTTON);
    expect(pushed(storage)).toContain(BUTTON);
    expect(pushed(storage)).not.toContain('<img');
  });

  it('certifies with several images in one table', () => {
    const two =
      '<table><tbody>' +
      '<tr><th>a</th><th>b</th></tr>' +
      `<tr><td rowspan="2">${BUTTON}</td><td><ac:image ac:width="30"><ri:attachment ri:filename="primary button.png"/></ac:image></td></tr>` +
      '<tr><td>x</td></tr>' +
      '</tbody></table>';

    expect(certified(two)).toBe(true);
    expect(convert(two)).toContain('primary%20button.png');
  });
});

describe('an attachment link inside a preserved table', () => {
  it('is written as an <a> labelled with the file name Confluence would draw', () => {
    const markdown = convert(preservedTable(SPREADSHEET));

    expect(markdown).toContain('<a href="EP/_attachments/146743218/Toplu%20F%C4%B0N.xlsx">');
    expect(markdown).toContain('>Toplu FİN.xlsx</a>');
  });

  it('certifies, so the page stays pushable', () => {
    expect(certified(preservedTable(SPREADSHEET))).toBe(true);
  });

  it('refuses a link carrying its own text, which would need a second escaping', () => {
    const withBody =
      '<ac:link><ri:attachment ri:filename="Toplu FİN.xlsx"/>' +
      '<ac:plain-text-link-body><![CDATA[the list]]></ac:plain-text-link-body></ac:link>';

    expect(convert(preservedTable(withBody))).toContain('confluence-block');
  });
});

describe('what still refuses the table', () => {
  it('an attachment that is not on disk — a broken link is worse than a pill', () => {
    // Not a rare case: an `ri:attachment` reference outlives the attachment it
    // names, and page 146743218 carries two links to files Confluence no longer
    // lists (FR-4.17).
    const missing = '<ac:link><ri:attachment ri:filename="Toplu VÖEN.xlsx"/></ac:link>';
    expect(convert(preservedTable(missing))).toContain('confluence-block');
  });

  it('an external image whose scheme §7.4 refuses', () => {
    // Unlike a missing attachment, this gate is about *safety* rather than
    // availability, and there is no file name to stand in for the picture.
    const unsafe = '<ac:image><ri:url ri:value="javascript:alert(1)"/></ac:image>';
    expect(convert(preservedTable(unsafe))).toContain('confluence-block');
  });

  it('a page link, which is O19 and not this decision', () => {
    const page = '<ac:link><ri:page ri:content-title="Elsewhere"/></ac:link>';
    expect(convert(preservedTable(page))).toContain('confluence-block');
  });

  it('a user mention, which has no vault equivalent at all', () => {
    const user = '<ac:link><ri:user ri:userkey="ff8081"/></ac:link>';
    expect(convert(preservedTable(user))).toContain('confluence-block');
  });

  it('a macro', () => {
    const macro =
      '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">X-1</ac:parameter></ac:structured-macro>';
    expect(convert(preservedTable(macro))).toContain('confluence-block');
  });

  it('one unshowable element among good ones — all or nothing, never half a table', () => {
    // A table half-translated would show a gap exactly where FR-4.9 says it must not,
    // so one unshowable element refuses the whole thing. A *missing attachment* is no
    // longer such an element — §6.4.17 stands its name in, because a name in text is
    // not a gap — so the case is now a page link, which has nothing to stand in with.
    const mixed =
      '<table><tbody>' +
      '<tr><th>a</th><th>b</th></tr>' +
      `<tr><td rowspan="2">${BUTTON}</td><td><ac:link><ri:page ri:content-title="X"/></ac:link></td></tr>` +
      '<tr><td>x</td></tr>' +
      '</tbody></table>';

    expect(convert(mixed)).toContain('confluence-block');
    expect(convert(mixed)).not.toContain('<img');
  });

  it('burns no fragment id on its way to being refused', () => {
    // The projection is planned in full before anything is allocated. Allocating as it
    // went would leave the refused table's half-finished work in the fragment cache and
    // push every later placeholder on the page up a number — which is what
    // `rollbackTo` is for, and this is the case that exercises it: the image *is*
    // projected, and then a later gate refuses the table anyway.
    const mixed =
      '<table><tbody>' +
      '<tr><th>a</th><th>b</th></tr>' +
      `<tr><td rowspan="2">${BUTTON}</td><td><ac:link><ri:page ri:content-title="X"/></ac:link></td></tr>` +
      '<tr><td>x</td></tr>' +
      '</tbody></table>';

    expect(convert(mixed)).toContain('id: cfb-0001');
  });

  it('shows a missing picture as its name, rather than hiding the table (§6.4.17)', () => {
    // Page 38549656: two of one table's three pictures are missing, and refusing on
    // them hid a nineteen-row specification of screen elements.
    const mixed =
      '<table><tbody>' +
      '<tr><th>a</th><th>b</th></tr>' +
      `<tr><td rowspan="2">${BUTTON}</td><td><ac:image><ri:attachment ri:filename="missing.png"/></ac:image></td></tr>` +
      '<tr><td>x</td></tr>' +
      '</tbody></table>';

    const markdown = convert(mixed);
    expect(markdown).toContain('<img');
    expect(markdown).toContain('<span class="cf-file">missing.png</span>');
    expect(markdown).not.toContain('confluence-block');
  });
});

describe('an image linked from another site', () => {
  const external =
    '<ac:image ac:width="16"><ri:url ri:value="https://jira.corp/icon.png"/></ac:image>';

  it('is shown, under the same scheme allowlist the prose form applies', () => {
    expect(convert(preservedTable(external))).toContain('<img src="https://jira.corp/icon.png"');
  });

  it('certifies', () => {
    expect(certified(preservedTable(external))).toBe(true);
  });

  it('refuses a scheme §7.4 does not allow, so a page body cannot become a script', () => {
    const unsafe = '<ac:image><ri:url ri:value="javascript:alert(1)"/></ac:image>';
    const markdown = convert(preservedTable(unsafe));

    expect(markdown).toContain('confluence-block');
    expect(markdown).not.toContain('javascript:');
  });
});

describe('the carrier, when the user edits around it', () => {
  it('restores the element even if the <img> in front of it was deleted', () => {
    // The same reasoning §6.4.8 applies to a deleted diagram embed and §6.4.9 to a
    // deleted glyph: an edit that only looked like a deletion must not silently
    // drop content from the Confluence page.
    const storage = preservedTable(BUTTON);
    const converted = storageToMarkdown(storage, OPTIONS);
    if (!converted.ok) throw new Error('conversion failed');

    const withoutImage = converted.value.markdown.replace(/<img\b[^>]*\/>/, '');
    expect(withoutImage).toContain('<!--cf-tbl:cfb-0001-->');
    expect(withoutImage).not.toContain('<img');
  });
});

describe('the URL form', () => {
  it('encodes per segment, so the separators survive', () => {
    expect(attachmentUrl('EP/_attachments/1/Secondary button.png')).toBe(
      'EP/_attachments/1/Secondary%20button.png',
    );
  });

  it('encodes the characters encodeURI would leave to truncate the path', () => {
    // `encodeURI` leaves `#`, `?` and `&` alone, and a file named `Q&A #2.png`
    // would then be fetched as `Q&A ` with a fragment after it.
    expect(attachmentUrl('EP/Q&A #2.png')).toBe('EP/Q%26A%20%232.png');
  });

  it('is anchored at the vault root, so relocating the note cannot break it', () => {
    expect(attachmentUrl('EP/_attachments/1/x.png').startsWith('EP/')).toBe(true);
  });
});

describe('a table refused after its media was hidden leaves nothing behind', () => {
  /** Which fragment ids the note actually points at. */
  function allocated(storage: string): { readonly held: string[]; readonly used: string[] } {
    const result = storageToMarkdown(storage, OPTIONS);
    if (!result.ok) throw new Error(result.error.userMessage);

    const held = [...result.value.fragments.keys()];
    return { held, used: held.filter((id) => result.value.markdown.includes(id)) };
  }

  it('rolls the image back when a macro is still in the table', () => {
    // The gate order is deliberate — media is hidden before the namespaced check, so
    // an image cannot be what refuses the table. But two gates still refuse *after*
    // it, and the ids taken for the images would otherwise stay in the sidecar
    // pointed at by nothing, with the table's own id past them.
    const macro = '<ac:structured-macro ac:name="jira"/>';
    const { held, used } = allocated(preservedTable(`${BUTTON}${macro}`));

    expect(held).toEqual(used);
    expect(held).toEqual(['cfb-0001']);
  });

  it('and when a blank line inside a <pre> makes the table unsplittable', () => {
    const { held, used } = allocated(preservedTable(`${BUTTON}<pre>one\n\ntwo</pre>`));

    expect(held).toEqual(used);
    expect(held).toEqual(['cfb-0001']);
  });

  it('while a table that keeps its projection keeps its ids', () => {
    const { held, used } = allocated(preservedTable(BUTTON));

    expect(held).toEqual(used);
    expect(held).toEqual(['cfb-0001']);
  });
});
