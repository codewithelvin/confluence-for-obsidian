import { describe, expect, it } from 'vitest';
import { certify } from '../../src/convert/round-trip-verifier';

/**
 * Round-trip fidelity for blocks inside other blocks (spec §6.4.4).
 *
 * Every shape here is taken from space EP, where a numbered step holding a nested
 * list or a table is the house style of a specification page. All of them
 * certified as `degraded` — readable but unpushable — until the two directions
 * were made to agree, and between them they accounted for the bulk of the
 * space's read-only pages.
 *
 * The assertion is always `certified`, never the Markdown: what went wrong was
 * never visible in the note, only in the trip back.
 */

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

describe('a list item that holds more than a paragraph', () => {
  it('keeps the paragraph wrapper when a table follows it', () => {
    // `<li>Step<table>` against an original of `<li><p>Step</p><table>` is a
    // difference in a wrapper nobody can see, and it cost the page its push.
    expect(
      certified(
        '<ol><li><p>Step</p><table><tbody><tr><th>A</th><th>B</th></tr>' +
          '<tr><td>1</td><td>2</td></tr></tbody></table></li></ol>',
      ),
    ).toBe(true);
  });

  it('keeps it when a nested list follows it', () => {
    expect(certified('<ol><li><p>Step</p><ul><li>inner</li></ul></li></ol>')).toBe(true);
  });

  it('keeps it two levels down', () => {
    expect(
      certified(
        '<ol><li><p>Step</p><ul><li><table><tbody><tr><th>A</th></tr>' +
          '<tr><td>1</td></tr></tbody></table></li></ul></li></ol>',
      ),
    ).toBe(true);
  });

  it('still drops it when the paragraph is the whole item', () => {
    // The one case §6.4.5 does declare equivalent, and the common one.
    expect(certified('<ol><li><p>Step</p></li><li><p>Other</p></li></ol>')).toBe(true);
  });
});

describe('whitespace the canonicalisations move (§6.4.5)', () => {
  it('trims the paragraph it wraps around a list item, not just pre-existing ones', () => {
    // The wrapper is created *after* the walk passes that position, so it never
    // gets its own visit. Untrimmed, its trailing space reached the note as
    // `&#x20;` — and `remark-parse` drops that space when the item has a sub-list,
    // so the page could not round-trip. Every note still carrying `&#x20;` was
    // read-only, a 100% correlation.
    expect(certified('<ul><li>db-migrations <ul><li>v2.0 </li></ul></li></ul>')).toBe(true);
  });

  it('lifts a space out of bold without losing it', () => {
    expect(certified('<p><strong>1.1. </strong><strong>Title</strong></p>')).toBe(true);
  });

  it('merges two identical spans', () => {
    const red = '<span style="color: rgb(255,0,0)">';
    expect(certified(`<p>${red}a</span>${red}b</span></p>`)).toBe(true);
  });

  it('merges emphasis written under either of its two tag names', () => {
    // `<strong>` and `<b>` render identically and Markdown writes them the same,
    // so a separator between them is noise. Comparing tag names literally left
    // `**&#x200B;**` in the middle of a heading — the last of the artefacts the
    // client reported.
    expect(certified('<p><strong>a</strong><b>b</b></p>')).toBe(true);
    expect(certified('<p><em>a</em><i>b</i></p>')).toBe(true);
    expect(certified('<p><em><strong>a</strong><b>b</b></em></p>')).toBe(true);
  });

  it('keeps emphasis that is nothing but a space', () => {
    expect(certified('<p>a<strong> </strong>b</p>')).toBe(true);
  });
});

describe('a line break next to inline HTML', () => {
  const red = '<span style="color: rgb(255,0,0)">';

  it('survives between two spans', () => {
    // `remark-stringify` writes a hard break as `\` and a newline — except beside
    // inline HTML, where it writes `\` and a *space*. A backslash before a space
    // is not an escape, so it re-parsed as a literal backslash and the break was
    // lost: `<span>a</span><br/><span>b</span>` came back as `…</span>\ <span…`.
    expect(certified(`<p>${red}a</span><br/>${red}b</span></p>`)).toBe(true);
  });

  it('survives between a span and plain text', () => {
    expect(certified(`<p>${red}a</span><br/>plain</p>`)).toBe(true);
  });

  it('survives twice over', () => {
    expect(certified(`<p>${red}a</span><br/><br/>b</p>`)).toBe(true);
  });

  it('still uses the tidier backslash form in ordinary prose', () => {
    expect(certified('<p>one<br/>two</p>')).toBe(true);
  });
});

describe('an anchor title', () => {
  it('survives the trip back', () => {
    // The reverse pass wrote `<a href="…">` and dropped the title, which cost the
    // tooltip and the page's push.
    expect(certified('<p><a href="https://x.example/" title="t">y</a></p>')).toBe(true);
    expect(certified('<p>see <a href="https://x.example/y" title="tip">y</a> now</p>')).toBe(true);
  });
});

describe('a paragraph this converter creates, not Confluence (§6.4.5)', () => {
  const table = '<table><tbody><tr><td colspan="2">x</td></tr></tbody></table>';

  it('gets every whitespace rule, not a subset of them', () => {
    // The walk visits children before parents, so a paragraph created during the
    // parent's visit never gets a visit of its own and has to be treated by hand.
    // Giving it only edge-trimming left a space *after* a `<br/>` inside it, which
    // Markdown writes line-initially as `&#x20;` — and all 42 notes carrying one
    // were read-only.
    expect(certified(`<ul><li>${table}Open:<br/> A<br/> B<br/> </li></ul>`)).toBe(true);
  });

  it('wraps a loose inline run at the top of a body', () => {
    // `<ac:image>` alone in a body is the common case: the forward pass gathers a
    // loose inline run into a paragraph, so the reverse writes a `<p>` the original
    // never had. 109 of the 138 notes holding an image embed failed on this.
    expect(certified('<ac:image><ri:attachment ri:filename="a.png"/></ac:image>')).toBe(true);
    expect(certified('<p>a</p>loose text at the end')).toBe(true);
  });
});

describe('a table written as HTML (D15)', () => {
  const table = '<table><tbody><tr><td colspan="2">x</td></tr></tbody></table>';

  it('round-trips at the top level, and beside prose', () => {
    expect(certified(table)).toBe(true);
    expect(certified(`<p>before</p>${table}<p>after</p>`)).toBe(true);
  });

  it('stays a placeholder where Markdown would indent it', () => {
    // Inside a list item or a quote, an HTML block runs until a blank line and
    // swallows the lines after it, so the body stops reproducing. A placeholder
    // there is honest; a table that eats the next paragraph is not.
    expect(certified(`<ul><li>${table}Open:<br/> A</li></ul>`)).toBe(true);
    expect(certified(`<blockquote>${table}</blockquote>`)).toBe(true);
  });
});

describe('table cells', () => {
  it('keeps a line break, which a Markdown table row cannot hold', () => {
    // `remark-stringify` writes a hard break inside a row as a plain space, so the
    // break was silently *lost* — not merely unreproducible. It is written as
    // `<br/>` instead.
    const storage =
      '<table><tbody><tr><th>A</th></tr><tr><td>one<br/>two</td></tr></tbody></table>';

    expect(certified(storage)).toBe(true);
  });

  it('carries a link, a styled span and an empty cell through unchanged', () => {
    expect(
      certified(
        '<table><tbody><tr><th>A</th><th>B</th></tr>' +
          '<tr><td><a href="https://x.example/y">y</a></td>' +
          '<td><span style="color: rgb(255,0,0)">red</span></td></tr>' +
          '<tr><td></td><td>2</td></tr></tbody></table>',
      ),
    ).toBe(true);
  });

  it('carries a paragraph-wrapped cell, which is how Confluence writes one', () => {
    expect(
      certified(
        '<table><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>',
      ),
    ).toBe(true);
  });
});
