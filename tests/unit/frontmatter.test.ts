import { describe, expect, it } from 'vitest';
import {
  joinFrontmatter,
  pageUrl,
  readIdentity,
  splitFrontmatter,
  toFrontmatterValue,
  type ConfluenceIdentity,
} from '../../src/vault/frontmatter';

const IDENTITY: ConfluenceIdentity = {
  id: '123456789',
  space: 'ENG',
  version: 42,
  parent: '123456700',
  url: 'https://wiki.corp/confluence/pages/viewpage.action?pageId=123456789',
  updated: '2026-08-09T14:03:11Z',
  updatedBy: 'j.smith',
  fidelity: 'certified',
};

describe('pageUrl', () => {
  it('builds a title-independent page URL', () => {
    expect(pageUrl('https://wiki.corp/confluence', '123')).toBe(
      'https://wiki.corp/confluence/pages/viewpage.action?pageId=123',
    );
  });
});

describe('toFrontmatterValue', () => {
  it('writes every key from the contract', () => {
    expect(Object.keys(toFrontmatterValue(IDENTITY)).sort()).toEqual([
      'fidelity',
      'id',
      'parent',
      'space',
      'updated',
      'updatedBy',
      'url',
      'version',
    ]);
  });

  it('writes an absent parent as an explicit null', () => {
    // `undefined` would be dropped by the serialiser, leaving no way to tell a
    // top-level page from one whose parent was never written.
    expect(toFrontmatterValue({ ...IDENTITY, parent: null })['parent']).toBeNull();
  });
});

describe('readIdentity', () => {
  it('round-trips what toFrontmatterValue wrote', () => {
    expect(readIdentity({ confluence: toFrontmatterValue(IDENTITY) })).toEqual(IDENTITY);
  });

  it('rejects frontmatter with no confluence block', () => {
    expect(readIdentity({ tags: ['a'] })).toBeNull();
    expect(readIdentity(null)).toBeNull();
    expect(readIdentity({ confluence: 'nonsense' })).toBeNull();
  });

  it('rejects a block missing the identifying keys', () => {
    // A half-written block must not produce a half-populated identity: the
    // index would then point sync at the wrong page.
    expect(readIdentity({ confluence: { version: 3 } })).toBeNull();
    expect(readIdentity({ confluence: { id: '1' } })).toBeNull();
  });

  it('defaults an unreadable fidelity to certified only when it is not degraded', () => {
    expect(readIdentity({ confluence: { id: '1', space: 'E', fidelity: 'degraded' } })?.fidelity) //
      .toBe('degraded');
    expect(readIdentity({ confluence: { id: '1', space: 'E' } })?.fidelity).toBe('certified');
  });
});

describe('splitFrontmatter', () => {
  it('separates a block from the body', () => {
    const split = splitFrontmatter('---\ntags: [a]\n---\n# Title\n\ntext\n');

    expect(split.frontmatter).toBe('---\ntags: [a]\n---\n');
    expect(split.body).toBe('# Title\n\ntext\n');
  });

  it('returns the whole content as body when there is no block', () => {
    expect(splitFrontmatter('# Title\n')).toEqual({ frontmatter: '', body: '# Title\n' });
  });

  it('does not treat a horizontal rule mid-note as a block', () => {
    const content = 'text\n\n---\n\nmore\n';
    expect(splitFrontmatter(content).frontmatter).toBe('');
  });

  it('leaves an unterminated block alone', () => {
    // Obsidian renders it as body text. Rewriting around it would hide content
    // the user can currently see.
    expect(splitFrontmatter('---\ntags: [a]\n# Title\n').frontmatter).toBe('');
  });

  it('tolerates CRLF line endings', () => {
    expect(splitFrontmatter('---\r\ntags: [a]\r\n---\r\nbody\r\n').frontmatter).toContain('tags');
  });

  it('handles a block with nothing after it', () => {
    expect(splitFrontmatter('---\ntags: [a]\n---\n').body).toBe('');
  });
});

describe('joinFrontmatter', () => {
  it('keeps the block and ends the body with exactly one newline', () => {
    expect(joinFrontmatter('---\na: 1\n---\n', '# Title\n\n\n')).toBe('---\na: 1\n---\n# Title\n');
  });

  it('normalises a body that arrives without a trailing newline', () => {
    // Otherwise the file hash would drift between syncs and every page would
    // look locally modified.
    expect(joinFrontmatter('', 'text')).toBe('text\n');
    expect(joinFrontmatter('', 'text\n')).toBe('text\n');
  });

  it('strips leading blank lines so the body starts right after the block', () => {
    expect(joinFrontmatter('---\na: 1\n---\n', '\n\ntext')).toBe('---\na: 1\n---\ntext\n');
  });

  it('leaves a note with a block and no body as just the block', () => {
    expect(joinFrontmatter('---\na: 1\n---\n', '   \n')).toBe('---\na: 1\n---\n');
  });
});
