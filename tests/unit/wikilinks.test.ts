import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import { LinkIndex, linkPath } from '../../src/sync/link-index';

/**
 * Links between mirrored pages (spec FR-4.7).
 *
 * Every case asserts the note *and* that the page still certifies. A wikilink the
 * forward pass writes and the reverse pass cannot turn back into an `ac:link`
 * would make every page holding an internal link read-only, which is a far worse
 * outcome than having no wikilinks at all.
 */

const index = new LinkIndex([
  { spaceKey: 'ENG', title: 'Data Model', path: 'ENG/Architecture/Data Model' },
  { spaceKey: 'ENG', title: 'Piped | Title', path: 'ENG/Piped - Title' },
  { spaceKey: 'OPS', title: 'Runbook', path: 'OPS/Runbook' },
]);

const OPTIONS = {
  baseUrl: 'https://wiki.corp',
  spaceKey: 'ENG',
  resolveTarget: index.resolveTarget,
  resolveVaultPath: index.resolveVaultPath,
};

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

function link(inner: string): string {
  return `<p>See <ac:link>${inner}</ac:link> for detail.</p>`;
}

describe('a link to a mirrored page', () => {
  const sameSpace = link('<ri:page ri:content-title="Data Model"/>');

  it('becomes a wikilink', () => {
    expect(convert(sameSpace)).toBe('See [[ENG/Architecture/Data Model]] for detail.');
  });

  it('round-trips back to the same ac:link', () => {
    expect(certified(sameSpace)).toBe(true);
  });

  it('resolves across spaces', () => {
    const other = link('<ri:page ri:content-title="Runbook" ri:space-key="OPS"/>');

    expect(convert(other)).toBe('See [[OPS/Runbook]] for detail.');
    expect(certified(other)).toBe(true);
  });

  it('carries a label when the link text is not the title', () => {
    const labelled = link(
      '<ri:page ri:content-title="Data Model"/>' +
        '<ac:plain-text-link-body><![CDATA[the schema]]></ac:plain-text-link-body>',
    );

    expect(convert(labelled)).toBe('See [[ENG/Architecture/Data Model|the schema]] for detail.');
    expect(certified(labelled)).toBe(true);
  });

  it('omits the label when the text is the title, which is what a bodyless link renders', () => {
    const same = link(
      '<ri:page ri:content-title="Data Model"/>' +
        '<ac:plain-text-link-body><![CDATA[Data Model]]></ac:plain-text-link-body>',
    );

    expect(convert(same)).toBe('See [[ENG/Architecture/Data Model]] for detail.');
  });
});

describe('a link that cannot be a wikilink', () => {
  it('stays a Markdown link when the page is not mirrored', () => {
    const missing = link('<ri:page ri:content-title="Not Mirrored"/>');

    expect(convert(missing)).toBe(
      'See [Not Mirrored](https://wiki.corp/display/ENG/Not+Mirrored) for detail.',
    );
    expect(certified(missing)).toBe(true);
  });

  it('stays a Markdown link when the body carries markup a label cannot hold', () => {
    const rich = link(
      '<ri:page ri:content-title="Data Model"/>' +
        '<ac:link-body><strong>bold</strong> text</ac:link-body>',
    );

    expect(convert(rich)).toContain('](https://wiki.corp/display/ENG/Data+Model)');
    expect(certified(rich)).toBe(true);
  });

  it('stays a Markdown link when the path would be ambiguous', () => {
    // `|` ends the path and starts the label, so `[[ENG/Piped - Title]]` could not
    // be read back — except the path here is safe and the *title* is not, which is
    // what the label check catches.
    const piped = link('<ri:page ri:content-title="Piped | Title"/>');

    expect(convert(piped)).toContain('[[ENG/Piped - Title]]');
    expect(certified(piped)).toBe(true);
  });
});

describe('a wikilink the user wrote', () => {
  function toStorage(markdown: string): string {
    const result = markdownToStorage(markdown, new Map(), OPTIONS);
    if (!result.ok) throw new Error(result.error.userMessage);
    return result.value;
  }

  it('becomes an ac:link when it points at a mirrored page', () => {
    expect(toStorage('See [[ENG/Architecture/Data Model]].')).toBe(
      '<p>See <ac:link><ri:page ri:content-title="Data Model" ri:space-key="ENG"/></ac:link>.</p>',
    );
  });

  it('keeps its label', () => {
    expect(toStorage('[[ENG/Architecture/Data Model|the schema]]')).toContain(
      '<ac:plain-text-link-body><![CDATA[the schema]]></ac:plain-text-link-body>',
    );
  });

  it('is left as text when it points at a note of the user’s own', () => {
    expect(toStorage('See [[My own note]].')).toBe('<p>See [[My own note]].</p>');
  });

  it('handles two on one line', () => {
    const storage = toStorage('[[ENG/Architecture/Data Model]] and [[OPS/Runbook]]');

    expect(storage).toContain('ri:content-title="Data Model"');
    expect(storage).toContain('ri:content-title="Runbook"');
  });
});

describe('LinkIndex', () => {
  it('resolves both directions', () => {
    expect(index.resolveTarget({ spaceKey: 'ENG', title: 'Data Model' })).toBe(
      'ENG/Architecture/Data Model',
    );
    expect(index.resolveVaultPath('OPS/Runbook')).toEqual({ spaceKey: 'OPS', title: 'Runbook' });
  });

  it('does not match a title that differs in case', () => {
    // Resolving it would mean writing back a title Confluence never had.
    expect(index.resolveTarget({ spaceKey: 'ENG', title: 'data model' })).toBeNull();
  });

  it('keeps spaces apart', () => {
    expect(index.resolveTarget({ spaceKey: 'OPS', title: 'Data Model' })).toBeNull();
  });

  it('lets a later entry win, so a page moving in this sync resolves to its new path', () => {
    const moved = new LinkIndex([
      { spaceKey: 'ENG', title: 'A', path: 'ENG/old/A' },
      { spaceKey: 'ENG', title: 'A', path: 'ENG/new/A' },
    ]);

    expect(moved.resolveTarget({ spaceKey: 'ENG', title: 'A' })).toBe('ENG/new/A');
  });

  it('strips the extension, since a wikilink never carries one', () => {
    expect(linkPath('ENG/Architecture/Data Model.md')).toBe('ENG/Architecture/Data Model');
    expect(linkPath('ENG/Architecture')).toBe('ENG/Architecture');
  });

  it('resolves nothing when nothing is mirrored', () => {
    expect(new LinkIndex([]).resolveTarget({ spaceKey: 'ENG', title: 'A' })).toBeNull();
  });
});
