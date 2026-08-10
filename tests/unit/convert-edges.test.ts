import { describe, expect, it } from 'vitest';
import type { PhrasingContent, RootContent } from 'mdast';
import { blocksToStorage } from '../../src/convert/markdown-blocks';
import { phrasingToStorage } from '../../src/convert/markdown-phrasing';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ReverseContext } from '../../src/convert/types';

/**
 * Edge and failure paths the golden corpus does not reach: malformed macros,
 * unusual Markdown, and the defensive branches that exist so unexpected input is
 * reported rather than silently dropped.
 */

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };
const EMPTY = new Map();

function markdownOf(xhtml: string): string {
  const result = storageToMarkdown(xhtml, OPTIONS);
  expect(result.ok).toBe(true);
  return result.ok ? result.value.markdown : '';
}

function storageOf(markdown: string): string {
  const result = markdownToStorage(markdown, EMPTY, OPTIONS);
  expect(result.ok, result.ok ? '' : result.error.userMessage).toBe(true);
  return result.ok ? result.value : '';
}

/** A context for driving the reverse converters directly. */
function reverseContext(source = ''): ReverseContext {
  const context: ReverseContext = {
    fragments: EMPTY,
    source,
    baseUrl: OPTIONS.baseUrl,
    spaceKey: OPTIONS.spaceKey,
    missingFragments: new Set<string>(),
    unsupported: new Set<string>(),
    blocks: (nodes) => blocksToStorage(nodes, context),
    phrasing: (nodes) => phrasingToStorage(nodes, context),
  };
  return context;
}

describe('malformed macros are preserved rather than mangled', () => {
  it('preserves a code macro with no body', () => {
    const markdown = markdownOf(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter></ac:structured-macro>',
    );
    expect(markdown).toContain('confluence-block');
    expect(markdown).toContain('no body');
  });

  it('preserves a code macro whose language collides with the placeholder fence', () => {
    const markdown = markdownOf(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">confluence-block</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(markdown).toContain('collides');
  });

  it('converts a panel with no body to an empty callout', () => {
    expect(markdownOf('<ac:structured-macro ac:name="info"/>')).toContain('[!info]');
  });

  it('preserves an expand macro carrying an unmodelled parameter', () => {
    const markdown = markdownOf(
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="hidden">true</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>',
    );
    expect(markdown).toContain('expand macro with unsupported parameters');
  });

  it('preserves a macro with no name', () => {
    expect(markdownOf('<ac:structured-macro/>')).toContain('confluence-block');
  });

  it('preserves an expand macro with no body', () => {
    expect(markdownOf('<ac:structured-macro ac:name="expand"/>')).toContain('[!note]-');
  });

  it('handles a task list containing a task with no id', () => {
    const markdown = markdownOf(
      '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>No id</ac:task-body></ac:task></ac:task-list>',
    );
    expect(markdown).toContain('- [ ] No id');
    expect(markdown).not.toContain('cf-task');
  });

  it('ignores a stray non-task inside a task list', () => {
    const markdown = markdownOf('<ac:task-list><p>stray</p></ac:task-list>');
    expect(markdown.trim()).toBe('');
  });

  it('unwraps an anchor with no href', () => {
    expect(markdownOf('<p><a>text</a></p>').trim()).toBe('text');
  });

  it('unwraps an unstyled span', () => {
    expect(markdownOf('<p>a <span>b</span> c</p>').trim()).toBe('a b c');
  });

  it('unwraps an unstyled div', () => {
    expect(markdownOf('<div><p>inner</p></div>').trim()).toBe('inner');
  });

  it('preserves an ac:link with an unrecognised resource', () => {
    expect(markdownOf('<p><ac:link><ri:space ri:space-key="ENG"/></ac:link></p>')).toContain(
      '{cf:',
    );
  });

  it('preserves an ac:link with no resource at all', () => {
    expect(markdownOf('<p><ac:link/></p>')).toContain('{cf:');
  });

  it('reads a link body containing formatting', () => {
    const markdown = markdownOf(
      '<p><ac:link><ri:page ri:content-title="P" ri:space-key="ENG"/><ac:link-body><strong>bold</strong></ac:link-body></ac:link></p>',
    );
    expect(markdown).toContain('**bold**');
  });
});

describe('reverse conversion of unusual Markdown', () => {
  it('writes a plain blockquote when there is no callout marker', () => {
    expect(storageOf('> just a quote\n')).toBe('<blockquote><p>just a quote</p></blockquote>');
  });

  it('treats an unknown callout kind as a plain blockquote', () => {
    expect(storageOf('> [!abstract] Summary\n')).toContain('<blockquote>');
  });

  it('keeps text following a callout marker in the same paragraph', () => {
    const storage = storageOf('> [!info] Title\n> continued here\n');
    expect(storage).toContain('ac:name="info"');
    expect(storage).toContain('continued here');
  });

  it('keeps inline formatting that follows a callout marker', () => {
    const storage = storageOf('> [!info] Title **bold**\n');
    expect(storage).toContain('ac:name="info"');
  });

  it('writes a list item whose first child is a nested list', () => {
    const storage = storageOf('-   - nested\n');
    expect(storage).toContain('<ul><li><ul>');
  });

  it('writes an ordered list', () => {
    expect(storageOf('1. one\n2. two\n')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('writes a multi-row table with a header', () => {
    const storage = storageOf('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n');
    expect(storage).toContain('<th>A</th>');
    expect(storage).toContain('<td>3</td>');
  });

  it('writes a hard line break', () => {
    expect(storageOf('a\\\nb\n')).toContain('<br/>');
  });

  it('writes a thematic break', () => {
    expect(storageOf('---\n')).toBe('<hr/>');
  });

  it('writes inline code as a code element', () => {
    expect(storageOf('`x()`\n')).toContain('<code>x()</code>');
  });

  it('escapes characters that would break the markup', () => {
    expect(storageOf('a < b & c\n')).toBe('<p>a &lt; b &amp; c</p>');
  });

  it('uses CDATA for code, falling back when it cannot nest', () => {
    expect(storageOf('```\nplain\n```\n')).toContain('<![CDATA[plain]]>');
    expect(storageOf('```\na]]>b\n```\n')).toContain('a]]&gt;b');
  });

  it('rejects a code fence whose info string is not parameters', () => {
    const result = markdownToStorage('```js not-parameters\nx\n```\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
  });

  it('rejects a footnote', () => {
    const result = markdownToStorage('a[^1]\n\n[^1]: note\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
  });
});

describe('recognising links back into Confluence', () => {
  it('treats a deeper path as an ordinary link', () => {
    expect(storageOf('[x](https://wiki.corp/display/ENG/A/B)\n')).toContain('<a href=');
  });

  it('treats a display URL with no title as an ordinary link', () => {
    expect(storageOf('[x](https://wiki.corp/display/ENG/)\n')).toContain('<a href=');
    expect(storageOf('[x](https://wiki.corp/display/)\n')).toContain('<a href=');
  });

  it('treats a malformed escape sequence as an ordinary link', () => {
    expect(storageOf('[x](https://wiki.corp/display/ENG/%ZZ)\n')).toContain('<a href=');
  });

  it('treats a different host as an ordinary link', () => {
    expect(storageOf('[x](https://other.corp/display/ENG/Page)\n')).toContain('<a href=');
  });

  it('writes a link body when the text differs from the title', () => {
    const storage = storageOf('[other words](https://wiki.corp/display/ENG/Page)\n');
    expect(storage).toContain('<ac:plain-text-link-body><![CDATA[other words]]>');
  });

  it('omits the body when the text is the title', () => {
    const storage = storageOf('[Page](https://wiki.corp/display/ENG/Page)\n');
    expect(storage).not.toContain('link-body');
  });

  it('uses a rich link body for formatted link text', () => {
    const storage = storageOf('[**bold**](https://wiki.corp/display/ENG/Page)\n');
    expect(storage).toContain('<ac:link-body><strong>bold</strong></ac:link-body>');
  });
});

describe('defensive branches', () => {
  it('reports an inline node type it does not recognise', () => {
    const context = reverseContext();
    const unknown = { type: 'madeUpInline', value: 'x' } as unknown as PhrasingContent;
    phrasingToStorage([unknown], context);

    expect(Array.from(context.unsupported)).toContain('an unrecognised inline element');
  });

  it('reports a block node type it does not recognise', () => {
    const context = reverseContext();
    const unknown = { type: 'madeUpBlock' } as unknown as RootContent;
    blocksToStorage([unknown], context);

    expect(Array.from(context.unsupported).join(' ')).toContain('madeUpBlock');
  });

  it('reports a link definition', () => {
    const context = reverseContext();
    blocksToStorage(
      [{ type: 'definition', identifier: 'a', label: 'a', url: 'https://x', title: null }],
      context,
    );
    expect(context.unsupported.size).toBe(1);
  });

  it('reports an image reference', () => {
    const context = reverseContext();
    phrasingToStorage(
      [{ type: 'imageReference', identifier: 'a', label: 'a', referenceType: 'full', alt: 'a' }],
      context,
    );
    expect(context.unsupported.size).toBe(1);
  });

  it('passes raw HTML through untouched', () => {
    const context = reverseContext();
    expect(phrasingToStorage([{ type: 'html', value: '<b>x</b>' }], context)).toBe('<b>x</b>');
  });
});

describe('certification failure modes', () => {
  it('reports a certification failure when the reverse pass rejects its own output', () => {
    // A parameter name containing a space cannot survive a fence info string:
    // it re-parses as a parameter plus stray text, which the reverse pass
    // refuses to push. The page stays readable; it is simply read-only.
    const result = certify(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
        '<ac:parameter ac:name="my param">v</ac:parameter>' +
        '<ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
      OPTIONS,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.certified).toBe(false);
    expect(result.value.detail).not.toBeNull();
    expect(result.value.markdown.length).toBeGreaterThan(0);
  });
});
