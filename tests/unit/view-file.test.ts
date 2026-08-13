import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { fileTarget, FILE_MACROS } from '../../src/convert/storage-file';
import { parseStorage } from '../../src/convert/storage-parser';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Document-preview macros, shown as the document (spec §6.4.13, D22, FR-4.20).
 *
 * Every shape here is one space EP actually stores: the `view-file` of page
 * 102597109 with its nested `ri:content-entity`, the bare `viewdoc` of
 * `TAXAZ-UPL-150-02`, and the `viewxls` of the tax-authority spreadsheet. Between
 * them they are 411 macros on 228 pages, and on 180 of those pages the macro was
 * the whole body.
 */

const ATTACHMENTS = new Map([
  ['TT_2317030000347800.docx', 'EP/_attachments/102597109/TT_2317030000347800.docx'],
  ['1-Tax authorities(Ex).xlsx', 'EP/_attachments/44214339/1-Tax authorities(Ex).xlsx'],
  ['Spec.pdf', 'EP/_attachments/44214339/Spec.pdf'],
]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
  resolveAttachment: (filename: string): string | null => ATTACHMENTS.get(filename) ?? null,
};

/** The macro exactly as page 102597109 stores it: the file's owning page named too. */
function viewFile(filename: string, height: string | null = '250'): string {
  const size = height === null ? '' : `<ac:parameter ac:name="height">${height}</ac:parameter>`;
  return (
    '<ac:structured-macro ac:name="view-file" ac:schema-version="1" ' +
    'ac:macro-id="c6c74135-9669-4788-9b4f-080a62d85d67">' +
    `<ac:parameter ac:name="name"><ri:attachment ri:filename="${filename}">` +
    '<ri:content-entity ri:content-id="102597109"/></ri:attachment></ac:parameter>' +
    `${size}</ac:structured-macro>`
  );
}

/** The older spelling, as `TAXAZ-UPL-150-02` stores it: no owner, no height. */
function viewdoc(filename: string, name = 'viewdoc'): string {
  return (
    `<ac:structured-macro ac:name="${name}" ac:schema-version="1" ` +
    'ac:macro-id="7ff48e56-25fb-47fd-bdbe-5176f454af0a">' +
    `<ac:parameter ac:name="name"><ri:attachment ri:filename="${filename}"/></ac:parameter>` +
    '</ac:structured-macro>'
  );
}

function convert(storage: string, options: ConversionOptions = OPTIONS): string {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

/** What a push would send for a note the user has edited. */
function push(markdown: string, storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('the attachment a document-preview macro names', () => {
  it('is read from the ri:attachment inside the name parameter', () => {
    const macro = parseStorage(viewFile('TT_2317030000347800.docx'));
    if (!macro.ok) throw new Error('unparsed');

    const element = macro.value.getElementsByTagName('ac:structured-macro')[0];
    expect(element).toBeDefined();
    expect(fileTarget(element as Element)).toBe('TT_2317030000347800.docx');
  });

  it("is read the same way when the macro names the file's owning page", () => {
    // 61 of the mirror's references nest an `ri:content-entity`; 55 of them name
    // this very page, and the 6 that do not are copied pages holding the same file.
    const macro = parseStorage(viewdoc('1-Tax authorities(Ex).xlsx', 'viewxls'));
    if (!macro.ok) throw new Error('unparsed');

    const element = macro.value.getElementsByTagName('ac:structured-macro')[0];
    expect(fileTarget(element as Element)).toBe('1-Tax authorities(Ex).xlsx');
  });

  it('is null for a macro that names nothing', () => {
    const macro = parseStorage('<ac:structured-macro ac:name="view-file" ac:schema-version="1"/>');
    if (!macro.ok) throw new Error('unparsed');

    const element = macro.value.getElementsByTagName('ac:structured-macro')[0];
    expect(fileTarget(element as Element)).toBeNull();
  });

  it('covers every spelling Confluence still renders', () => {
    expect([...FILE_MACROS].sort()).toEqual([
      'view-file',
      'viewdoc',
      'viewpdf',
      'viewppt',
      'viewxls',
    ]);
  });
});

describe('a document-preview macro at body level', () => {
  it('becomes the embed of the file it names, with the macro carried beside it', () => {
    expect(convert(viewFile('TT_2317030000347800.docx'))).toBe(
      '![[EP/_attachments/102597109/TT_2317030000347800.docx]]<!--cf-file:cfb-0001-->',
    );
  });

  it('shows the older spellings the same way', () => {
    expect(convert(viewdoc('1-Tax authorities(Ex).xlsx', 'viewxls'))).toBe(
      '![[EP/_attachments/44214339/1-Tax authorities(Ex).xlsx]]<!--cf-file:cfb-0001-->',
    );
  });

  it('hands Confluence back the identical macro, so the page stays certified', () => {
    expect(certified(viewFile('TT_2317030000347800.docx'))).toBe(true);
    expect(certified(viewdoc('1-Tax authorities(Ex).xlsx', 'viewxls'))).toBe(true);
    expect(certified(viewFile('Spec.pdf', null))).toBe(true);
  });

  it('replaces the paragraph rather than being wrapped in one', () => {
    // The macro was a child of the body. A `<p>` around it on the way back is
    // markup Confluence never sent, and would make the page read-only.
    const storage = viewFile('TT_2317030000347800.docx');
    expect(push(convert(storage), storage)).toBe(storage);
  });

  it('keeps a parameter it does not model, because the fragment holds the macro whole', () => {
    // `height` is presentational and is not drawn — but it is not lost either: the
    // push hands back the element Confluence sent, `height` and all.
    const storage = viewFile('TT_2317030000347800.docx', '400');
    expect(push(convert(storage), storage)).toContain('<ac:parameter ac:name="height">400');
  });

  it('stays a widget when the file is not on disk', () => {
    // FR-4.17. An `ri:attachment` reference outlives the attachment it names, and
    // 44 of the mirror's 411 point at a file Confluence no longer lists.
    const markdown = convert(viewdoc('TAXAZ-UPL-150-02-Paket yükləmə jurnalına baxmaq.docx'));
    expect(markdown).toContain('```confluence-block');
    expect(markdown).toContain('label: viewdoc macro — TAXAZ-UPL-150-02-Paket');
    expect(markdown).not.toContain('![[');
  });

  it('names the file in the widget, so the reader knows which document is missing', () => {
    expect(convert(viewdoc('Missing report.xlsx', 'viewxls'))).toContain(
      'label: viewxls macro — Missing report.xlsx',
    );
  });
});

describe('an edited note holding a shown document', () => {
  it('puts the macro back when the user deleted the embed and left the marker', () => {
    // The same guarantee §6.4.8 gives a deleted diagram: an edit that only looked
    // like a deletion does not silently drop the macro from the page.
    const storage = viewFile('TT_2317030000347800.docx');
    expect(push('<!--cf-file:cfb-0001-->', storage)).toBe(storage);
  });

  it('carries the marker into the storage when the user typed over the embed', () => {
    // The marker no longer describes what is there, so it is left unread — and the
    // push verifier then stops the page rather than guessing.
    const storage = viewFile('TT_2317030000347800.docx');
    expect(push('my own words<!--cf-file:cfb-0001-->', storage)).toContain('cf-file:cfb-0001');
  });

  it('survives prose added around it', () => {
    const storage = `<p>Before</p>${viewFile('TT_2317030000347800.docx')}<p>After</p>`;
    const markdown = convert(storage);

    expect(markdown).toContain('![[EP/_attachments/102597109/TT_2317030000347800.docx]]');
    expect(push(markdown, storage)).toBe(storage);
  });
});
