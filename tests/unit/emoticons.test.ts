import { describe, expect, it } from 'vitest';
import { restoreEmoticons } from '../../src/convert/emoticons';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';

/**
 * Emoticons (spec §6.4.9, D18, FR-4.15).
 *
 * Two things are being asserted throughout, and they are separate: that the
 * character *appears* in the note, and that the original element comes back
 * **exactly**. The second is what keeps the page pushable, and it is asserted
 * against the stored markup rather than through `normalise` on both sides —
 * `mergeAdjacentInline` once deleted a space and still certified, so a rule that
 * runs on both sides of the comparison proves nothing.
 */

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };

function markdownOf(storage: string): string {
  const result = storageToMarkdown(storage, OPTIONS);
  if (!result.ok) throw new Error(`conversion failed: ${JSON.stringify(result.error)}`);
  return result.value.markdown;
}

function certified(storage: string): { certified: boolean; detail: string | null } {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(`certification errored: ${JSON.stringify(result.error)}`);
  return { certified: result.value.certified, detail: result.value.detail };
}

describe('an emoticon in ordinary prose', () => {
  it('becomes the character, followed by an invisible carrier', () => {
    const markdown = markdownOf('<p>Status <ac:emoticon ac:name="tick"/> confirmed</p>');
    expect(markdown).toContain('Status ✅<!--cf-emo:tick--> confirmed');
  });

  it('is no longer a placeholder', () => {
    const markdown = markdownOf('<p><ac:emoticon ac:name="yellow-star"/></p>');
    expect(markdown).not.toContain('{cf:');
    expect(markdown).toContain('⭐');
  });

  it('certifies, so the page stays pushable', () => {
    expect(certified('<p>Status <ac:emoticon ac:name="tick"/> confirmed</p>').certified).toBe(true);
  });

  it('certifies for every name in the mapping', () => {
    const names = [
      'tick',
      'cross',
      'warning',
      'information',
      'question',
      'plus',
      'minus',
      'light-on',
      'yellow-star',
      'thumbs-up',
      'thumbs-down',
      'smile',
      'sad',
      'laugh',
      'wink',
      'cheeky',
    ];
    for (const name of names) {
      const result = certified(`<p>a <ac:emoticon ac:name="${name}"/> b</p>`);
      expect(result.certified, `${name}: ${result.detail ?? ''}`).toBe(true);
    }
  });

  it('round-trips a glyph that is more than one code point', () => {
    // `⚠️` is U+26A0 U+FE0F. A reverse pass that captured a single character would
    // take the variation selector and leave the warning sign behind in the page.
    const result = certified('<p>Careful <ac:emoticon ac:name="warning"/></p>');
    expect(result.certified, result.detail ?? '').toBe(true);
    expect(markdownOf('<p>Careful <ac:emoticon ac:name="warning"/></p>')).toContain(
      '⚠️<!--cf-emo:warning-->',
    );
  });

  it('keeps several in one paragraph apart', () => {
    const storage = '<p><ac:emoticon ac:name="tick"/> yes <ac:emoticon ac:name="cross"/> no</p>';
    expect(markdownOf(storage)).toContain('✅<!--cf-emo:tick--> yes ❌<!--cf-emo:cross--> no');
    expect(certified(storage).certified).toBe(true);
  });

  it('stays a placeholder when the name is not in the mapping', () => {
    // `light-off` is deliberately unmapped: no character reads as a dimmed bulb,
    // and a wrong glyph in a specification page is worse than an honest pill.
    const markdown = markdownOf('<p><ac:emoticon ac:name="light-off"/></p>');
    expect(markdown).toContain('{cf:');
  });

  it('stays a placeholder when the element carries more than its name', () => {
    // Dropping an attribute would make the page unreproducible, so the whole
    // element is preserved instead.
    const markdown = markdownOf('<p><ac:emoticon ac:name="tick" ac:emoji-id="2705"/></p>');
    expect(markdown).toContain('{cf:');
  });
});

describe('an emoticon the user has edited around', () => {
  it('goes back when its character was deleted but the carrier left behind', () => {
    const back = restoreEmoticons('<td>gone<!--cf-emo:tick--></td>');
    expect(back).toBe('<td>gone<ac:emoticon ac:name="tick"/></td>');
  });

  it('leaves a character the user typed themselves as text', () => {
    // No carrier, so it is the user's own tick and not Confluence's.
    expect(restoreEmoticons('<td>✅ done</td>')).toBe('<td>✅ done</td>');
  });

  it('leaves a carrier naming something not in the mapping alone', () => {
    expect(restoreEmoticons('<td>x<!--cf-emo:light-off--></td>')).toBe(
      '<td>x<!--cf-emo:light-off--></td>',
    );
  });

  it('does nothing to a string holding no carrier at all', () => {
    const html = '<td>plain <!--cf-th--> cell</td>';
    expect(restoreEmoticons(html)).toBe(html);
  });
});

/**
 * The point of D18. These tables fail GFM on *structure* — a span, a block in a
 * cell — so the HTML projection is the only route they have, and it used to refuse
 * them for holding namespaced markup that Obsidian can in fact show.
 */
describe('a table refused only for its emoticons', () => {
  const spanned =
    '<table><tbody>' +
    '<tr><th>Column</th><th>Required</th></tr>' +
    '<tr><td rowspan="2">Name</td><td><ac:emoticon ac:name="tick"/></td></tr>' +
    '<tr><td><ac:emoticon ac:name="cross"/></td></tr>' +
    '</tbody></table>';

  it('is written out as a visible table instead of a placeholder', () => {
    const markdown = markdownOf(spanned);
    expect(markdown).not.toContain('confluence-block');
    expect(markdown).toContain('<table>');
    expect(markdown).toContain('✅<!--cf-emo:tick-->');
    expect(markdown).toContain('❌<!--cf-emo:cross-->');
  });

  it('leaves no namespaced markup in the note', () => {
    // FR-4.9 is untouched by D18: the tag is translated, never leaked.
    const markdown = markdownOf(spanned);
    expect(markdown).not.toContain('ac:emoticon');
  });

  it('certifies, so the page around it is still editable', () => {
    const result = certified(spanned);
    expect(result.certified, result.detail ?? '').toBe(true);
  });

  it('is still refused when a cell also holds an image', () => {
    const withImage =
      '<table><tbody>' +
      '<tr><th>Column</th><th>Icon</th></tr>' +
      '<tr><td rowspan="2">Name</td><td><ac:emoticon ac:name="tick"/></td></tr>' +
      '<tr><td><ac:image ac:width="30"><ri:attachment ri:filename="b.png"/></ac:image></td></tr>' +
      '</tbody></table>';
    expect(markdownOf(withImage)).toContain('confluence-block');
  });

  it('is still refused when one of its emoticons is unmapped', () => {
    // Half-translating would show a gap exactly where FR-4.9 says it must not.
    const mixed =
      '<table><tbody>' +
      '<tr><th>Column</th><th>Required</th></tr>' +
      '<tr><td rowspan="2">Name</td><td><ac:emoticon ac:name="tick"/></td></tr>' +
      '<tr><td><ac:emoticon ac:name="light-off"/></td></tr>' +
      '</tbody></table>';
    expect(markdownOf(mixed)).toContain('confluence-block');
  });

  it('keeps an inline comment anchor working beside an emoticon', () => {
    // Both carriers are HTML comments inside the same raw block, and both have to
    // come back — the anchor restoration and the emoticon restoration compose.
    const both =
      '<table><tbody>' +
      '<tr><th>Column</th><th>Required</th></tr>' +
      '<tr><td rowspan="2"><ac:inline-comment-marker ac:ref="abc-123">Name</ac:inline-comment-marker></td>' +
      '<td><ac:emoticon ac:name="tick"/></td></tr>' +
      '<tr><td>x</td></tr>' +
      '</tbody></table>';
    const result = certified(both);
    expect(result.certified, result.detail ?? '').toBe(true);
  });
});

/**
 * A grid GFM *can* express takes the ordinary path, where an emoticon is inline
 * content in a cell. Worth its own case: the carrier then sits inside a Markdown
 * table cell rather than inside raw HTML.
 */
describe('an emoticon in a table GFM can express', () => {
  const simple =
    '<table><tbody>' +
    '<tr><th>Column</th><th>Required</th></tr>' +
    '<tr><td>Name</td><td><ac:emoticon ac:name="tick"/></td></tr>' +
    '</tbody></table>';

  it('renders as a GFM table holding the character', () => {
    const markdown = markdownOf(simple);
    expect(markdown).toContain('| Column | Required');
    expect(markdown).toContain('| Name   | ✅<!--cf-emo:tick--> |');
  });

  it('certifies', () => {
    const result = certified(simple);
    expect(result.certified, result.detail ?? '').toBe(true);
  });
});
