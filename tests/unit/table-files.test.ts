import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Document-preview macros inside a preserved table (spec §6.4.17, D26, FR-4.24).
 *
 * The table is page 112363703's — `22. Qərar və Nizamnamə formaları`, a four-column
 * grid of the Word forms a taxpayer files for each kind of change, seven `view-file`
 * macros and a `rowspan`. All of it was one grey pill, and **four of its seven
 * documents are in the vault**, which is why a missing file must not refuse the table.
 */

const ON_DISK = new Map([
  ['dəyişiklik (2).docx', 'EP/_attachments/112363703/dəyişiklik (2).docx'],
  ['rəhbər dəyişikliyi (1).doc', 'EP/_attachments/112363703/rəhbər dəyişikliyi (1).doc'],
]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
  resolveAttachment: (filename) => ON_DISK.get(filename) ?? null,
};

/** The macro exactly as page 112363703 stores it, `height` included. */
function viewFile(filename: string): string {
  return (
    '<ac:structured-macro ac:name="view-file" ac:schema-version="1" ' +
    'ac:macro-id="8f52ee51-82f6-46f0-93ad-165fe85339e2">' +
    `<ac:parameter ac:name="name"><ri:attachment ri:filename="${filename}"/></ac:parameter>` +
    '<ac:parameter ac:name="height">400</ac:parameter></ac:structured-macro>'
  );
}

/** The grid, with its `rowspan` — which is what refuses GFM in the first place. */
function formsTable(...cells: string[]): string {
  const row = cells.map((cell) => `<td><p>${cell}</p></td>`).join('');
  return (
    '<table><tbody>' +
    '<tr><th>Dəyişdirilən məlumat</th><th>Qərar</th></tr>' +
    `<tr><td rowspan="6"><p>Hüquqi ünvan</p></td>${row}</tr>` +
    '</tbody></table>'
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

describe('a document-preview macro inside a preserved table', () => {
  it('becomes a link that opens the file, rather than hiding the table', () => {
    const markdown = convert(formsTable(viewFile('dəyişiklik (2).docx')));

    // Built with `encodeURIComponent`, not written out: hand-encoding `ə` (U+0259 →
    // `%C9%99`) is a mistake I have now made three times in one day.
    const href = `EP/_attachments/112363703/${encodeURIComponent('dəyişiklik (2).docx')}`;
    expect(markdown).toContain(`<a href="${href}">dəyişiklik (2).docx</a>`);
    // The grid is visible now — labels, header and all.
    expect(markdown).toContain('Dəyişdirilən məlumat');
    expect(markdown).toContain('Hüquqi ünvan');
    expect(markdown).not.toContain('```confluence-block');
  });

  it('shows a file that is not on disk as its name, and keeps the table', () => {
    // The departure from `hideTableMediaIn`'s all-or-nothing rule. A name written as
    // text is not the gap FR-4.9 forbids: the cell still says which document belongs
    // there. Four of page 112363703's seven documents are in the vault, and refusing
    // on the other three would hide the four along with the whole grid.
    const markdown = convert(formsTable(viewFile('müşahidə şurası.doc')));

    expect(markdown).toContain('<span class="cf-file">müşahidə şurası.doc</span>');
    expect(markdown).not.toContain('```confluence-block');
    expect(markdown).not.toContain('href');
  });

  it('mixes the two in one table, which is the real page', () => {
    const markdown = convert(
      formsTable(viewFile('rəhbər dəyişikliyi (1).doc'), viewFile('hüquqi ünvan qərar (2).doc')),
    );

    expect(markdown).toContain('>rəhbər dəyişikliyi (1).doc</a>');
    expect(markdown).toContain('<span class="cf-file">hüquqi ünvan qərar (2).doc</span>');
  });

  it('keeps the page certified either way', () => {
    expect(certified(formsTable(viewFile('dəyişiklik (2).docx')))).toBe(true);
    expect(certified(formsTable(viewFile('müşahidə şurası.doc')))).toBe(true);
  });

  it('hands Confluence back the identical macro, height parameter included', () => {
    const storage = formsTable(viewFile('dəyişiklik (2).docx'));
    const restored = push(convert(storage), storage);

    expect(restored).toBe(storage);
    expect(restored).toContain('<ac:parameter ac:name="height">400</ac:parameter>');
  });

  it("restores a missing file's macro from the name that stood in for it", () => {
    const storage = formsTable(viewFile('müşahidə şurası.doc'));
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('restores several in one table, in order', () => {
    const storage = formsTable(
      viewFile('rəhbər dəyişikliyi (1).doc'),
      viewFile('hüquqi ünvan qərar (2).doc'),
    );
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('covers the older macro spellings too', () => {
    const viewxls = viewFile('dəyişiklik (2).docx').replace('view-file', 'viewxls');
    expect(convert(formsTable(viewxls))).toContain('>dəyişiklik (2).docx</a>');
  });

  it('still refuses the table when the macro names no file at all', () => {
    // Nothing to say: not a missing document, but a macro this does not understand.
    const nameless = '<ac:structured-macro ac:name="view-file" ac:schema-version="1"/>';
    expect(convert(formsTable(nameless))).toContain('```confluence-block');
  });

  it('still refuses the table for a macro that is not a document preview', () => {
    const toc = '<ac:structured-macro ac:name="toc" ac:schema-version="1"/>';
    expect(convert(formsTable(toc))).toContain('```confluence-block');
  });

  it('stands in for a picture that is not on disk, keeping the table (§6.4.10)', () => {
    // Page 38549656: two of one table's three pictures are missing, and D19's
    // all-or-nothing rule hid a nineteen-row specification of screen elements over it.
    const image = (name: string): string =>
      `<ac:image><ri:attachment ri:filename="${name}"/></ac:image>`;
    const storage = formsTable(image('dəyişiklik (2).docx'), image('gone.jpg'));
    const markdown = convert(storage);

    expect(markdown).toContain('<img src=');
    expect(markdown).toContain('<span class="cf-file">gone.jpg</span>');
    expect(markdown).not.toContain('```confluence-block');
    expect(push(markdown, storage)).toBe(storage);
  });

  it('still refuses a table whose external image the scheme allowlist rejects', () => {
    // §7.4's gate is about safety, not availability, and has no file name to show.
    const storage = formsTable('<ac:image><ri:url ri:value="javascript:alert(1)"/></ac:image>');
    expect(convert(storage)).toContain('```confluence-block');
  });

  it('leaves a styled span the author wrote alone', () => {
    // The reverse pattern requires the `cf-file` class, so an author's span cannot be
    // swallowed into a fragment that never described it. A *bare* `<span>` never
    // reaches the note at all — §6.4.6 unwraps one — but the pattern does not lean on
    // that, because leaning on another pass's behaviour is how a rule breaks silently.
    const authors = '<span style="color: rgb(255,0,0)">plain</span>';
    const storage = formsTable(`${authors}${viewFile('dəyişiklik (2).docx')}`);
    const restored = push(convert(storage), storage);

    expect(restored).toBe(storage);
    expect(restored).toContain(authors);
  });
});
