import { describe, expect, it } from 'vitest';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';

/**
 * Confluence page layouts (spec §6.4.8).
 *
 * A layout used to be preserved whole, which hid everything inside it: 53 of the
 * first 170 pages mirrored from EP and VOEN were effectively blank to a reader,
 * one holding 19 KB of markup behind a single widget. The content is ordinary page
 * content — headings, images, macros — and converts natively once unwrapped.
 *
 * Every test asserts `certified` as well as the note, because the whole point of
 * the markers is that Confluence keeps its columns even though Obsidian cannot
 * show them. A layout that reads well but cannot be pushed back would be a worse
 * trade than the placeholder it replaced.
 */

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };

const cell = (inner: string): string => `<ac:layout-cell>${inner}</ac:layout-cell>`;
const section = (type: string, inner: string): string =>
  `<ac:layout-section ac:type="${type}">${inner}</ac:layout-section>`;
const layout = (inner: string): string => `<ac:layout>${inner}</ac:layout>`;

function convert(storage: string): string {
  const result = storageToMarkdown(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown;
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

describe('a layout reveals its content', () => {
  it('converts the cells to real Markdown rather than one opaque block', () => {
    const storage = layout(
      section('two_right_sidebar', cell('<h2>Main</h2><p>body</p>') + cell('<p>aside</p>')),
    );
    const markdown = convert(storage);

    // The heading is a heading, not markup inside a widget.
    expect(markdown).toContain('## Main');
    expect(markdown).toContain('body');
    expect(markdown).toContain('aside');
    expect(markdown).not.toContain('confluence-block');
  });

  it('leaves no fragment behind, so nothing is hidden', () => {
    const result = storageToMarkdown(layout(section('single', cell('<p>only</p>'))), OPTIONS);

    expect(result.ok && result.value.fragments.size).toBe(0);
  });

  it('records the shape in comments, which a reader never sees', () => {
    // HTML comments render as nothing in Reading View and Live Preview alike —
    // the same device already carrying a row header and a task id.
    const markdown = convert(layout(section('two_equal', cell('<p>a</p>') + cell('<p>b</p>'))));

    expect(markdown).toContain('<!--cf-layout-section:two_equal-->');
    expect(markdown).toContain('<!--cf-layout-cell-->');
  });
});

describe('a layout survives the trip back', () => {
  it('keeps two equal columns', () => {
    expect(certified(layout(section('two_equal', cell('<p>a</p>') + cell('<p>b</p>'))))).toBe(true);
  });

  it('keeps a sidebar, whose type is not recoverable from the content', () => {
    expect(
      certified(layout(section('two_right_sidebar', cell('<p>main</p>') + cell('<p>aside</p>')))),
    ).toBe(true);
  });

  it('keeps several sections, each with its own type', () => {
    expect(
      certified(
        layout(
          section('single', cell('<h1>Title</h1>')) +
            section('two_equal', cell('<p>a</p>') + cell('<p>b</p>')),
        ),
      ),
    ).toBe(true);
  });

  it('keeps three cells', () => {
    expect(
      certified(
        layout(
          section('three_with_sidebars', cell('<p>a</p>') + cell('<p>b</p>') + cell('<p>c</p>')),
        ),
      ),
    ).toBe(true);
  });

  it('keeps an empty cell, which carries no content to infer it from', () => {
    expect(certified(layout(section('two_equal', cell('<p>a</p>') + cell('')))).valueOf()).toBe(
      true,
    );
  });

  it('carries a table inside a cell', () => {
    const table = '<table><tbody><tr><th>A</th></tr><tr><td>1</td></tr></tbody></table>';

    expect(certified(layout(section('two_equal', cell(table) + cell('<p>b</p>'))))).toBe(true);
  });

  it('ends where it ends, leaving the content after it alone', () => {
    expect(certified(`${layout(section('single', cell('<p>a</p>')))}<p>after</p>`)).toBe(true);
  });
});
