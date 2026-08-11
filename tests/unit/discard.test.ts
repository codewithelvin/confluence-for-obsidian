import { describe, expect, it } from 'vitest';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';

/**
 * The §6.4.6 discard pass, exercised through the converter rather than directly.
 *
 * What matters about each rule is the note it produces and whether the page still
 * certifies — a rule applied to conversion but not to normalisation would look
 * perfect here and make the page read-only in the vault.
 */

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };
const STRICT = { ...OPTIONS, strictMarkup: true };

function convert(storage: string, options = OPTIONS): string {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown;
}

function fragmentCount(storage: string, options = OPTIONS): number {
  const result = storageToMarkdown(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.fragments.size;
}

function certified(storage: string, options = OPTIONS): boolean {
  const result = certify(storage, options);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

describe('anchor macros (§6.4.6)', () => {
  const anchor =
    '<p>Text with <ac:structured-macro ac:name="anchor" ac:schema-version="1">' +
    '<ac:parameter ac:name="">top</ac:parameter></ac:structured-macro>an anchor.</p>';

  it('leaves nothing behind, since Confluence renders nothing', () => {
    expect(convert(anchor)).toBe('Text with an anchor.\n');
    expect(fragmentCount(anchor)).toBe(0);
  });

  it('keeps the page certified, so dropping it does not cost the push', () => {
    expect(certified(anchor)).toBe(true);
  });

  it('preserves it under strict markup (FR-4.12)', () => {
    expect(convert(anchor, STRICT)).toContain('{cf:');
    expect(fragmentCount(anchor, STRICT)).toBe(1);
  });
});

describe('presentational spans (§6.4.6)', () => {
  it('unwraps a span that only restates the default text colour', () => {
    const storage = '<p><span style="color: rgb(23,43,77);">Ordinary prose.</span></p>';

    expect(convert(storage)).toBe('Ordinary prose.\n');
    expect(certified(storage)).toBe(true);
  });

  it('unwraps black-on-black too', () => {
    expect(convert('<p><span style="color: rgb(0,0,0)">x</span></p>')).toBe('x\n');
  });

  it('keeps a colour that is actually a colour, and writes it as HTML', () => {
    const storage = '<p><span style="color: rgb(255,0,0);">warning</span></p>';

    expect(convert(storage)).toBe('<span style="color: rgb(255,0,0)">warning</span>\n');
    expect(fragmentCount(storage)).toBe(0);
    expect(certified(storage)).toBe(true);
  });

  it('drops letter-spacing but keeps the emphasis it was attached to', () => {
    const storage = '<p><strong style="letter-spacing: 0.0px;">Bold</strong></p>';

    expect(convert(storage)).toBe('**Bold**\n');
    expect(certified(storage)).toBe(true);
  });
});

describe('editor artefacts (§6.4.6)', () => {
  it('turns a class-only heading into a real Markdown heading', () => {
    const storage = '<h2 class="auto-cursor-target">Overview</h2>';

    expect(convert(storage)).toBe('## Overview\n');
    expect(certified(storage)).toBe(true);
  });

  it('reads a forced newline as a hard line break', () => {
    const storage = '<p>First<br class="atl-forced-newline"/>second</p>';

    expect(convert(storage)).toBe('First\\\nsecond\n');
    expect(certified(storage)).toBe(true);
  });

  it('drops a trailing no-break space instead of encoding it as &#x20;', () => {
    const storage = '<p>TAXAZ-210-00&nbsp;</p>';

    expect(convert(storage)).toBe('TAXAZ-210-00\n');
    expect(certified(storage)).toBe(true);
  });

  it('removes an empty paragraph', () => {
    expect(convert('<p>One</p><p/><p>Two</p>')).toBe('One\n\nTwo\n');
  });
});

describe('vertical space between blocks (§6.4.6)', () => {
  it('collapses a run of spacer paragraphs to the blank line Markdown already has', () => {
    const storage = '<p>One</p><p><br/></p><p><br/></p><p>Two</p>';

    expect(convert(storage)).toBe('One\n\nTwo\n');
    expect(certified(storage)).toBe(true);
  });

  it('drops a break at the end of a paragraph, where the paragraph already ends', () => {
    const storage = '<p>User: The Ministry of Taxes<br/></p><p>Next</p>';

    expect(convert(storage)).toBe('User: The Ministry of Taxes\n\nNext\n');
    expect(certified(storage)).toBe(true);
  });

  it('drops a leading break instead of writing a dangling backslash', () => {
    const storage = '<p><br/>Version: 0.5</p>';

    expect(convert(storage)).toBe('Version: 0.5\n');
    expect(certified(storage)).toBe(true);
  });

  it('keeps a break in the middle, which is a real line break', () => {
    const storage = '<p>First<br/>second</p>';

    expect(convert(storage)).toBe('First\\\nsecond\n');
    expect(certified(storage)).toBe(true);
  });

  it('preserves the spacers under strict markup (FR-4.12)', () => {
    expect(convert('<p>One</p><p><br/></p><p>Two</p>', STRICT)).toContain('<p><br/></p>');
  });
});

describe('tables freed by the discard pass (§6.4.6)', () => {
  it('writes a table whose only obstacle was Confluence CSS as a real table', () => {
    const storage =
      '<table class="wrapped"><colgroup><col/><col/></colgroup><tbody>' +
      '<tr><th class="highlight-grey" title="Background colour : Grey">Version</th><th>Date</th></tr>' +
      '<tr><td>1.0</td><td>13 September 2019</td></tr>' +
      '</tbody></table>';

    expect(convert(storage)).toBe(
      '| Version | Date              |\n' +
        '| ------- | ----------------- |\n' +
        '| 1.0     | 13 September 2019 |\n',
    );
    expect(fragmentCount(storage)).toBe(0);
    expect(certified(storage)).toBe(true);
  });

  it('writes a merged-cell table as HTML rather than hiding it (D15)', () => {
    // GFM cannot express a colspan, but Obsidian renders one — and storage format
    // is already XHTML, so the table can simply be itself. Visible *and* still
    // pushable, which the placeholder never was.
    const storage =
      '<table><tbody><tr><th>A</th><th>B</th></tr>' +
      '<tr><td colspan="2">merged</td></tr></tbody></table>';

    expect(convert(storage)).toBe(`${storage}\n`);
    expect(fragmentCount(storage)).toBe(0);
    expect(certified(storage)).toBe(true);
  });

  it('keeps a table opaque when a cell holds markup Obsidian cannot render (FR-4.9)', () => {
    // An `ac:image` written into a note renders as *nothing*, so the reader would
    // see an empty cell where the picture belongs. 681 of EP's tables are this.
    const storage =
      '<table><tbody><tr><th>A</th><th>B</th></tr>' +
      '<tr><td colspan="2"><ac:image><ri:attachment ri:filename="a.png"/></ac:image></td></tr>' +
      '</tbody></table>';

    expect(fragmentCount(storage)).toBe(1);
    expect(convert(storage)).not.toContain('<ac:');
    expect(certified(storage)).toBe(true);
  });
});

describe('tables GFM cannot mark, but can still reproduce', () => {
  // Confluence's specification tables label their leading column with `<th>` in
  // every row. GFM has no way to mark one, and until the marker existed every
  // page holding such a table certified as read-only the moment §6.4.6 freed it.
  const rowHeaders =
    '<table><tbody>' +
    '<tr><th>Element</th><th>Type</th></tr>' +
    '<tr><th>Login</th><td>field</td></tr>' +
    '</tbody></table>';

  it('writes the row header as a table and keeps the page certified', () => {
    expect(convert(rowHeaders)).toBe(
      '| Element           | Type  |\n' +
        '| ----------------- | ----- |\n' +
        '| Login<!--cf-th--> | field |\n',
    );
    expect(certified(rowHeaders)).toBe(true);
  });

  it('puts every row into one tbody, whatever section it started in', () => {
    const split =
      '<table>' +
      '<thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
      '</table>';

    expect(convert(split)).toBe('| A | B |\n| - | - |\n| 1 | 2 |\n');
    expect(certified(split)).toBe(true);
  });

  it('wraps rows that had no section at all', () => {
    const loose = '<table><tr><th>A</th></tr><tr><td>1</td></tr></table>';

    expect(convert(loose)).toBe('| A |\n| - |\n| 1 |\n');
    expect(certified(loose)).toBe(true);
  });
});

describe('namespaced markup never reaches a note (FR-4.9)', () => {
  const heading =
    '<h1 style="text-align: right;"><ac:image ac:thumbnail="true">' +
    '<ri:attachment ri:filename="Homepage.jpg"/></ac:image></h1>';

  it('drops the alignment rather than writing out an ac: tag', () => {
    const markdown = convert(heading);

    expect(markdown).not.toContain('<ac:');
    expect(markdown).not.toContain('<ri:');
    expect(markdown).toContain('#');
    expect(certified(heading)).toBe(true);
  });

  it('preserves the whole block opaquely under strict markup, still without ac: tags', () => {
    const markdown = convert(heading, STRICT);

    expect(markdown).not.toContain('<ac:');
    expect(markdown).toContain('confluence-block');
  });
});
