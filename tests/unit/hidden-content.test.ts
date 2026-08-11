import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Content that was preserved for a reason that turned out not to be one.
 *
 * Reading a mirrored specification page against the Confluence page it came from
 * showed the prose arriving intact and the *pictures and tables* arriving as
 * labels. Counted across all 1 469 mirrored notes, three causes accounted for
 * nearly all of it, and none of the three was a construct Markdown cannot hold:
 *
 *  - 2 651 images carried `ac:width` *and* `ac:height`, and the embed writer took
 *    only a width;
 *  - 216 more sat inside a `<strong>` an author had left on a line holding a
 *    picture;
 *  - 107 of the 1 655 preserved tables held no namespaced markup except an
 *    inline comment's anchor — a yellow highlight over two words was the whole
 *    reason the table was opaque.
 *
 * 94% of the images behind a placeholder already had their file downloaded and
 * sitting in `_attachments`, unreferenced by any note.
 *
 * Every test asserts `certified` alongside the note. Revealing content by making
 * a page unpushable would be a worse trade than the placeholder it replaced.
 */

const DOWNLOADED = new Map([['Diagram.png', 'EP/_attachments/123/Diagram.png']]);

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://wiki.corp',
  spaceKey: 'EP',
  resolveAttachment: (filename: string): string | null => DOWNLOADED.get(filename) ?? null,
  attachmentFor: (path: string): string | null => {
    for (const [filename, candidate] of DOWNLOADED) {
      if (candidate === path) return filename;
    }
    return null;
  },
};

const EMBED = 'EP/_attachments/123/Diagram.png';
const ATTACHED = '<ri:attachment ri:filename="Diagram.png"/>';

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

/** The body that would be pushed for a page pulled from this storage. */
function pushed(storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(forward.value.markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('an image sized in both directions (FR-8.2)', () => {
  it('becomes an embed, which Obsidian sizes as width by height', () => {
    const sized = `<p><ac:image ac:width="500" ac:height="400">${ATTACHED}</ac:image></p>`;

    expect(convert(sized)).toBe(`![[${EMBED}|500x400]]`);
    expect(certified(sized)).toBe(true);
  });

  it('certifies whichever order Confluence wrote the two attributes in', () => {
    // Normalisation sorts attributes, so the reverse pass may settle on one order.
    const reversed = `<p><ac:image ac:height="400" ac:width="500">${ATTACHED}</ac:image></p>`;

    expect(convert(reversed)).toBe(`![[${EMBED}|500x400]]`);
    expect(certified(reversed)).toBe(true);
  });

  it('shows at its natural size when only a height is given', () => {
    // An embed label is read as a *width*, so a height alone cannot go in it. 549
    // images in the mirror are this shape: near enough beats not at all, and the
    // carried source keeps the height for Confluence.
    const tall = `<p><ac:image ac:height="400">${ATTACHED}</ac:image></p>`;

    expect(convert(tall)).toBe(`![[${EMBED}]]<!--cf-img:cfb-0001-->`);
    expect(certified(tall)).toBe(true);
  });

  it('keeps its size when a border rides along with it', () => {
    const bordered = `<p><ac:image ac:width="500" ac:height="400" ac:border="true">${ATTACHED}</ac:image></p>`;

    expect(convert(bordered)).toBe(`![[${EMBED}|500x400]]<!--cf-img:cfb-0001-->`);
    expect(certified(bordered)).toBe(true);
  });

  it('leaves a label the converter never wrote as the text it is', () => {
    // A user may size an embed their own way, or embed a file of their own. Either
    // is Markdown of theirs, not an `ac:image` to rebuild.
    const own = markdownToStorage(`![[${EMBED}|thumbnail]]`, new Map(), OPTIONS);
    if (!own.ok) throw new Error(own.error.userMessage);

    expect(own.value).not.toContain('ac:image');
    expect(own.value).toContain('thumbnail');
  });
});

describe('an image whose source rides beside it (FR-8.2)', () => {
  const bordered = `<p><ac:image ac:width="500" ac:border="true">${ATTACHED}</ac:image></p>`;

  it('hands Confluence back the original markup, border and all', () => {
    expect(pushed(bordered)).toContain(
      `<ac:image ac:width="500" ac:border="true">${ATTACHED}</ac:image>`,
    );
  });

  it('puts the marker after the embed, so the line is not an HTML block', () => {
    // A line *starting* with `<!--` is an HTML block in CommonMark, and it would
    // swallow the embed on the same line — the picture would stop rendering
    // entirely, which is the problem this is meant to solve.
    expect(convert(bordered).startsWith('![[')).toBe(true);
  });

  it('survives the user deleting the picture but not the marker', () => {
    // Half an edit. The image goes back rather than vanishing from Confluence,
    // and a real deletion still shows up in the push diff.
    const forward = storageToMarkdown(bordered, OPTIONS);
    if (!forward.ok) throw new Error(forward.error.userMessage);

    const edited = forward.value.markdown.replace(`![[${EMBED}|500]]`, 'Deleted the picture. ');
    const back = markdownToStorage(edited, forward.value.fragments, OPTIONS);
    if (!back.ok) throw new Error(back.error.userMessage);

    expect(back.value).toContain('Deleted the picture.');
    expect(back.value).toContain('ac:border="true"');
  });

  it('refuses the push when the fragment cache has lost the source', () => {
    // Better a blocked push than one that quietly drops the border — or the
    // picture — because the note outlived its cache.
    const forward = storageToMarkdown(bordered, OPTIONS);
    if (!forward.ok) throw new Error(forward.error.userMessage);

    const orphaned = markdownToStorage(forward.value.markdown, new Map(), OPTIONS);

    expect(orphaned.ok).toBe(false);
  });
});

describe('emphasis wrapped around a picture (§6.4.5)', () => {
  it('is dropped, so the image inside it becomes an embed', () => {
    // Bold changes glyphs and an image has none, so the wrapper renders as
    // nothing at all — but it has no word for Markdown emphasis to attach to, so
    // it used to be preserved whole, taking the picture with it.
    const bold = `<p><strong><ac:image ac:width="1000">${ATTACHED}</ac:image></strong></p>`;

    expect(convert(bold)).toBe(`![[${EMBED}|1000]]`);
    expect(certified(bold)).toBe(true);
  });

  it('is dropped for italics too, and for a run of several images', () => {
    const italic = `<p><em><ac:image>${ATTACHED}</ac:image><ac:image>${ATTACHED}</ac:image></em></p>`;

    expect(convert(italic)).not.toContain('{cf:');
    expect(certified(italic)).toBe(true);
  });

  it('is kept when there is a word in it, because then it is real emphasis', () => {
    const captioned = `<p><strong>Figure 1 <ac:image>${ATTACHED}</ac:image></strong></p>`;

    expect(convert(captioned)).toContain('**');
    expect(convert(captioned)).toContain(`![[${EMBED}]]`);
  });

  it('is dropped around a macro too, which frees the table of contents', () => {
    // 41 pages open with `<strong><ac:structured-macro ac:name="toc"/></strong>`,
    // and the wrapper made the whole thing one nameless inline placeholder — the
    // renderer could not tell it was a contents list, so it read
    // "strong without word content" where the page's navigation belonged.
    const toc = '<p><strong><ac:structured-macro ac:name="toc"/></strong></p>';

    expect(convert(toc)).toContain('name: toc');
    expect(certified(toc)).toBe(true);
  });

  it('is kept around wordless text, which Markdown really cannot write', () => {
    // `**№**` is not emphasis to CommonMark. Wordless bold punctuation outnumbers
    // both the images and the macros, and every one of them must stay preserved.
    expect(convert('<p><strong>№</strong></p>')).toContain('{cf:');
  });
});

describe('two emphasis runs with a space between them (§6.4.5)', () => {
  it('keeps the space, because it is the space between two words', () => {
    // Merging across it deleted it — and both sides of the fidelity comparison
    // lost it alike, so the page still certified while its text was wrong. It
    // reached the reader as `kabinetigöndərilən` in a page heading.
    const split = '<p><strong>kabineti</strong> <strong>göndərilən</strong></p>';

    expect(convert(split)).toBe('**kabineti** **göndərilən**');
    expect(certified(split)).toBe(true);
  });

  it('still merges two runs that really do touch', () => {
    // The case the merge exists for: Markdown reads `**a****b**` as one run, so
    // without merging the converter had to separate them with a zero-width space.
    const touching = '<p><strong>a</strong><strong>b</strong></p>';

    expect(convert(touching)).toBe('**ab**');
    expect(certified(touching)).toBe(true);
  });
});

describe('a preformatted block (§6.4.2)', () => {
  const pre =
    '<pre><code><span style="color: rgb(128,128,128)">-- SORĞU 1\nSELECT 1;</span>\n\n</code></pre>';

  it('is a code fence the reader can read, not a grey widget', () => {
    // Preserved whole until now, for a reason that was never about the reader: a
    // bare fence is indistinguishable from a code macro with no language. The
    // marker settles which it was, so the fence can be a fence.
    expect(convert(pre)).toBe('```\n-- SORĞU 1\nSELECT 1;\n```\n\n<!--cf-pre:cfb-0001-->');
    expect(certified(pre)).toBe(true);
  });

  it('goes back as the <pre> it was, colour span and all', () => {
    expect(pushed(pre)).toContain('<pre><code><span style="color: rgb(128,128,128)">');
  });

  it('is left alone as a code macro when nothing marks it', () => {
    // A fence the user wrote is a code macro, which is what Confluence writes.
    const own = markdownToStorage('```sql\nSELECT 1;\n```\n', new Map(), OPTIONS);
    if (!own.ok) throw new Error(own.error.userMessage);

    expect(own.value).toContain('ac:name="code"');
    expect(own.value).not.toContain('<pre>');
  });
});

describe('the zero margin Confluence stamps on a pasted document (§6.4.6)', () => {
  it('does not cost a list its bullets', () => {
    // `margin-left: 0.0px` is the default written out longhand, and one attribute
    // anywhere in a list preserves the whole list. A VOEN support page carries it
    // on the heading, both tables, every row, cell, paragraph, `<strong>` and
    // `<code>` — and on both of its diagnostic checklists, which reached the
    // reader as "list with item styling".
    const list =
      '<ul style="margin-left: 0.0px"><li><p style="margin-left: 0.0px">Ssenari A</p>' +
      '<ul style="margin-left: 0.0px"><li><p style="margin-left: 0.0px">Analiz</p></li></ul>' +
      '</li></ul>';

    expect(convert(list)).toBe('- Ssenari A\n  - Analiz');
    expect(certified(list)).toBe(true);
  });

  it('keeps a margin that really indents something', () => {
    // Confluence writes `margin-left: 30.0px` for a genuinely indented paragraph.
    // That is content, and it stays — which is why the rule tests the value.
    expect(convert('<p style="margin-left: 30.0px">Indented</p>')).toContain('margin-left');
  });
});

describe("a table holding an inline comment's anchor (FR-4.9, FR-4.10)", () => {
  // A two-column table with no header row: GFM cannot express it, so it takes the
  // HTML projection of D15 — which the anchor alone used to disqualify.
  const anchored =
    '<table><tbody><tr><td><p>Qəbul kriteriyası</p></td>' +
    '<td><p>Status <ac:inline-comment-marker ac:ref="207a9caa-7b89">aktiv</ac:inline-comment-marker>' +
    ' olmalıdır</p></td></tr></tbody></table>';

  it('is written into the note as a table the reader can see', () => {
    const markdown = convert(anchored);

    expect(markdown).toContain('<table>');
    expect(markdown).toContain('aktiv');
    expect(markdown).not.toContain('```confluence-block');
  });

  it('carries the anchor as an HTML comment, which renders as nothing', () => {
    expect(convert(anchored)).toContain('<!--cf-comment:207a9caa-7b89-->');
  });

  it('gives Confluence the anchor back exactly, so the comment stays attached', () => {
    expect(pushed(anchored)).toContain(
      '<ac:inline-comment-marker ac:ref="207a9caa-7b89">aktiv</ac:inline-comment-marker>',
    );
    expect(certified(anchored)).toBe(true);
  });

  it('stays preserved when the anchor carries more than a ref', () => {
    // Anything beyond `ac:ref` would be lost on the way back, and a table the
    // reader can see is not worth a page that can no longer be pushed.
    const extra = anchored.replace('ac:ref="207a9caa-7b89"', 'ac:ref="207a9caa-7b89" ac:x="1"');

    expect(convert(extra)).toContain('```confluence-block');
    expect(certified(extra)).toBe(true);
  });

  it('stays preserved when the table also holds markup Obsidian renders as nothing', () => {
    const withImage = anchored.replace(
      '<p>Qəbul kriteriyası</p>',
      `<p><ac:image>${ATTACHED}</ac:image></p>`,
    );

    expect(convert(withImage)).toContain('```confluence-block');
    expect(certified(withImage)).toBe(true);
  });

  it('keeps working for the anchors that appear in ordinary prose', () => {
    // Outside a table an anchor is still a placeholder pair, and this change must
    // not have moved that: the words between them stay readable either way.
    const prose =
      '<p>Servisin <ac:inline-comment-marker ac:ref="abc">yazılması</ac:inline-comment-marker>.</p>';

    expect(convert(prose)).toContain('yazılması');
    expect(certified(prose)).toBe(true);
  });
});

/**
 * The two defects that made an HTML table stop being one (D15, FR-4.10).
 *
 * A CommonMark HTML block ends at a **blank line**, and Markdown puts only a
 * single newline between two blocks inside a list item. Between them those two
 * facts accounted for more unpushable pages in the mirror than anything else:
 * 56% of the 592 EP notes holding an HTML table were read-only, against 6.6% of
 * notes without one, and a further 953 preserved tables were opaque purely
 * because of where they sat.
 *
 * Both are fixed on the DOM, before serialisation. `CANONICAL` collapses runs of
 * whitespace on both sides of the comparison (§6.4.5), which is what makes
 * rewriting insignificant whitespace free in certification terms.
 */
describe('a blank line inside a projected table (D15)', () => {
  /** `colspan` is what puts this table on the HTML projection path at all. */
  const table = (cell: string): string =>
    `<table><tbody><tr><td colspan="2">${cell}</td></tr></tbody></table>`;

  it('renders the table instead of hiding it behind a placeholder', () => {
    const storage = table('<p>alpha</p>\n\n<p>beta</p>');

    expect(convert(storage)).not.toContain('```confluence-block');
    expect(convert(storage)).toContain('<p>alpha</p>');
    expect(convert(storage)).toContain('<p>beta</p>');
    expect(certified(storage)).toBe(true);
  });

  it('leaves no blank line in the note, which would cut the block in two', () => {
    const storage = table('<p>alpha</p>\n\n\n<p>beta</p>');

    expect(convert(storage)).not.toMatch(/\n[ \t]*\n/);
    expect(certified(storage)).toBe(true);
  });

  it('keeps the paragraph after the table out of the table', () => {
    const storage = `${table('<p>alpha</p>\n\n<p>beta</p>')}<p>after</p>`;

    expect(pushed(storage)).toContain('</table><p>after</p>');
    expect(certified(storage)).toBe(true);
  });

  it('stays preserved when the blank line is inside a preformatted block', () => {
    // There the whitespace *is* the content, so it cannot be rewritten and the
    // table cannot be one HTML block. An honest placeholder is the only answer.
    const storage = table('<pre>one\n\ntwo</pre>');

    expect(convert(storage)).toContain('```confluence-block');
    expect(certified(storage)).toBe(true);
  });

  it('says why such a table is preserved, rather than blaming macros', () => {
    // A label describing the wrong thing is its own bug: this table holds no
    // macro, image or link.
    expect(convert(table('<pre>one\n\ntwo</pre>'))).toContain('preformatted text');
    expect(convert(table('<code>one\n\ntwo</code>'))).toContain('preformatted text');
  });

  it('still renders a preformatted block that has no blank line', () => {
    const storage = table('<pre>one\ntwo</pre>');

    expect(convert(storage)).not.toContain('```confluence-block');
    expect(certified(storage)).toBe(true);
  });
});

describe('a table inside a list item or a quote (D15)', () => {
  const TABLE = '<table><tbody><tr><td colspan="2">alpha</td></tr></tbody></table>';

  it('renders rather than becoming an opaque block', () => {
    const storage = `<ul><li><p>step one</p>${TABLE}</li></ul>`;

    expect(convert(storage)).not.toContain('```confluence-block');
    expect(convert(storage)).toContain('<table>');
    expect(certified(storage)).toBe(true);
  });

  it('does not swallow the paragraph that follows it', () => {
    const storage = `<ul><li><p>step one</p>${TABLE}<p>after</p></li></ul>`;

    expect(pushed(storage)).toContain('</table><p>after</p>');
    expect(certified(storage)).toBe(true);
  });

  it('does not swallow a nested list that follows it', () => {
    // The case that proves the trailing newline is necessary rather than tidy.
    // Without it `- sub` is absorbed into the HTML block and reproduced as the
    // literal text of a paragraph, and the sub-list is gone.
    const storage = `<ul><li><p>step one</p>${TABLE}<ul><li>sub</li></ul></li></ul>`;

    expect(pushed(storage)).toContain('<ul><li>sub</li></ul>');
    expect(certified(storage)).toBe(true);
  });

  it('does not swallow the list item that follows it', () => {
    const storage = `<ul><li>${TABLE}</li><li><p>second</p></li></ul>`;

    expect(pushed(storage)).toContain('</li><li>second</li>');
    expect(certified(storage)).toBe(true);
  });

  it('works inside a blockquote too', () => {
    const storage = `<blockquote>${TABLE}<p>after</p></blockquote>`;

    expect(convert(storage)).not.toContain('```confluence-block');
    expect(pushed(storage)).toContain('</table><p>after</p>');
    expect(certified(storage)).toBe(true);
  });

  it('adds no blank line under a table that is not indented', () => {
    // Markdown already separates top-level blocks, so the extra newline would put
    // a visible gap under every table on the pages where this already worked.
    expect(convert(TABLE)).toBe(TABLE);
  });

  it('handles both defects at once', () => {
    const storage =
      '<ul><li><table><tbody><tr><td colspan="2"><p>a</p>\n\n<p>b</p></td></tr>' +
      '</tbody></table><p>after</p></li></ul>';

    expect(convert(storage)).not.toContain('```confluence-block');
    expect(pushed(storage)).toContain('</table><p>after</p>');
    expect(certified(storage)).toBe(true);
  });
});
