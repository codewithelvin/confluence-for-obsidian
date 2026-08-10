import { describe, expect, it } from 'vitest';
import {
  isParamsOnly,
  parseMacroParams,
  serialiseMacroParams,
} from '../../src/convert/macro-params';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { normaliseMarkdown, normaliseStorage } from '../../src/convert/normalise';
import {
  PlaceholderRegistry,
  blockPlaceholderBody,
  collapse,
  inlinePlaceholderValue,
  readBlockPlaceholderId,
  readInlinePlaceholderId,
} from '../../src/convert/placeholder-registry';
import { certify, firstDifference, verify } from '../../src/convert/round-trip-verifier';
import {
  acAttr,
  decodeHtmlEntities,
  parseStorage,
  riAttr,
  tagOf,
} from '../../src/convert/storage-parser';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';

const OPTIONS = { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' };
const EMPTY = new Map();

describe('macro parameters in a fence info string', () => {
  it('round-trips values', () => {
    const params = new Map([
      ['linenumbers', 'true'],
      ['theme', 'Midnight'],
    ]);
    expect(parseMacroParams(serialiseMacroParams(params))).toEqual(params);
  });

  it('serialises keys in sorted order for determinism', () => {
    const params = new Map([
      ['z', '1'],
      ['a', '2'],
    ]);
    expect(serialiseMacroParams(params)).toBe('a="2" z="1"');
  });

  it('escapes quotes and backslashes', () => {
    const params = new Map([['title', 'He said "hi" \\ bye']]);
    const serialised = serialiseMacroParams(params);
    expect(parseMacroParams(serialised).get('title')).toBe('He said "hi" \\ bye');
  });

  it('preserves values containing spaces', () => {
    expect(parseMacroParams('title="Two words"').get('title')).toBe('Two words');
  });

  it('ignores anything that is not a parameter', () => {
    expect(parseMacroParams('some prose here').size).toBe(0);
  });

  it('treats absent meta as empty', () => {
    expect(parseMacroParams(null).size).toBe(0);
    expect(parseMacroParams(undefined).size).toBe(0);
  });

  it('recognises an info string made only of parameters', () => {
    expect(isParamsOnly(null)).toBe(true);
    expect(isParamsOnly('a="1" b="2"')).toBe(true);
    expect(isParamsOnly('a="1" leftover')).toBe(false);
    expect(isParamsOnly('just prose')).toBe(false);
  });
});

describe('PlaceholderRegistry', () => {
  const input = { kind: 'block' as const, xhtml: '<x/>', type: 'macro', label: 'a label' };

  it('assigns padded ids in document order', () => {
    const registry = new PlaceholderRegistry();
    expect(registry.add(input).id).toBe('cfb-0001');
    expect(registry.add(input).id).toBe('cfb-0002');
    expect(registry.size).toBe(2);
  });

  it('assigns the same ids for the same sequence, so conversion is repeatable', () => {
    const ids = (): string[] => {
      const registry = new PlaceholderRegistry();
      return [registry.add(input).id, registry.add(input).id];
    };
    expect(ids()).toEqual(ids());
  });

  it('snapshots independently of later additions', () => {
    const registry = new PlaceholderRegistry();
    registry.add(input);
    const snapshot = registry.snapshot();
    registry.add(input);
    expect(snapshot.size).toBe(1);
  });

  it('round-trips an inline placeholder id', () => {
    const fragment = new PlaceholderRegistry().add({ ...input, kind: 'inline' });
    expect(readInlinePlaceholderId(inlinePlaceholderValue(fragment))).toBe(fragment.id);
  });

  it('does not mistake ordinary inline code for a placeholder', () => {
    for (const value of ['npm install', '{cf:}', '{cf:not-an-id}', 'cfb-0001', '']) {
      expect(readInlinePlaceholderId(value)).toBeNull();
    }
  });

  it('round-trips a block placeholder id', () => {
    const fragment = new PlaceholderRegistry().add(input);
    expect(readBlockPlaceholderId(blockPlaceholderBody(fragment))).toBe(fragment.id);
  });

  it('returns null for a fence body with no id', () => {
    expect(readBlockPlaceholderId('type: macro\nname: jira')).toBeNull();
    expect(readBlockPlaceholderId('')).toBeNull();
  });

  it('omits an absent macro name from the body', () => {
    const fragment = new PlaceholderRegistry().add({ ...input, name: null });
    expect(blockPlaceholderBody(fragment)).not.toContain('name:');
  });

  it('collapses whitespace and truncates long labels', () => {
    expect(collapse('  a \n b  ')).toBe('a b');
    expect(collapse('x'.repeat(200)).length).toBe(120);
    expect(collapse('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('entity decoding', () => {
  it('decodes named HTML entities that XML does not define', () => {
    expect(decodeHtmlEntities('&nbsp;')).toBe(' ');
    expect(decodeHtmlEntities('&mdash;')).toBe('—');
    expect(decodeHtmlEntities('&copy;')).toBe('©');
  });

  it('leaves XML built-ins for the parser to handle', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('leaves numeric references untouched', () => {
    expect(decodeHtmlEntities('&#169;&#xA9;')).toBe('&#169;&#xA9;');
  });

  it('does not decode a prefix of a real entity', () => {
    // `&not` is a real entity, so a naive decoder turns `&notarealentity;` into
    // `¬arealentity;` and silently corrupts the page.
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('escapes a decoded character that would itself break XML', () => {
    expect(decodeHtmlEntities('&lt;')).toBe('&lt;');
  });
});

describe('parseStorage', () => {
  it('parses namespaced storage format', () => {
    const result = parseStorage('<ac:structured-macro ac:name="code"/>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const macro = result.value.firstElementChild;
    expect(macro).not.toBeNull();
    expect(tagOf(macro!)).toBe('ac:structured-macro');
    expect(acAttr(macro!, 'name')).toBe('code');
  });

  it('reads ri: attributes', () => {
    const result = parseStorage('<ac:image><ri:attachment ri:filename="a.png"/></ac:image>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const attachment = result.value.firstElementChild?.firstElementChild;
    expect(riAttr(attachment!, 'filename')).toBe('a.png');
  });

  it('accepts an empty body', () => {
    expect(parseStorage('').ok).toBe(true);
  });

  it('rejects malformed markup rather than guessing', () => {
    const result = parseStorage('<p>unclosed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED_RESPONSE');
  });

  it('rejects an undefined entity rather than altering content', () => {
    expect(parseStorage('<p>&notarealentity;</p>').ok).toBe(false);
  });
});

describe('normaliseMarkdown', () => {
  it('normalises line endings, trailing spaces and blank runs', () => {
    expect(normaliseMarkdown('a  \r\n\r\n\r\n\r\nb   \n')).toBe('a\n\nb');
  });

  it('leaves already-normal text unchanged', () => {
    expect(normaliseMarkdown('a\n\nb')).toBe('a\n\nb');
  });
});

describe('normaliseStorage', () => {
  it('sorts attributes so order is not a difference', () => {
    expect(normaliseStorage('<p b="2" a="1">x</p>')).toBe(normaliseStorage('<p a="1" b="2">x</p>'));
  });

  it('ignores server-generated identities', () => {
    const withIds = '<ac:structured-macro ac:name="code" ac:macro-id="abc" ac:schema-version="1"/>';
    expect(normaliseStorage(withIds)).toBe(
      normaliseStorage('<ac:structured-macro ac:name="code"/>'),
    );
    expect(normaliseStorage('<table ac:local-id="9"/>')).toBe(normaliseStorage('<table/>'));
  });

  it('collapses insignificant whitespace', () => {
    expect(normaliseStorage('<p>a   b</p>')).toBe(normaliseStorage('<p>a b</p>'));
    expect(normaliseStorage('<ul>\n  <li>a</li>\n</ul>')).toBe(
      normaliseStorage('<ul><li>a</li></ul>'),
    );
  });

  it('preserves whitespace where it is significant', () => {
    const spaced = '<ac:plain-text-body>a   b</ac:plain-text-body>';
    const single = '<ac:plain-text-body>a b</ac:plain-text-body>';
    expect(normaliseStorage(spaced)).not.toBe(normaliseStorage(single));
  });

  it('treats CDATA and escaped text as equivalent', () => {
    expect(normaliseStorage('<ac:plain-text-body><![CDATA[a<b]]></ac:plain-text-body>')).toBe(
      normaliseStorage('<ac:plain-text-body>a&lt;b</ac:plain-text-body>'),
    );
  });

  it('makes an implicit same-space page reference explicit', () => {
    const implicit = '<ac:link><ri:page ri:content-title="X"/></ac:link>';
    const explicit = '<ac:link><ri:page ri:content-title="X" ri:space-key="ENG"/></ac:link>';
    expect(normaliseStorage(implicit, { defaultSpaceKey: 'ENG' })).toBe(
      normaliseStorage(explicit, { defaultSpaceKey: 'ENG' }),
    );
  });

  it('keeps a cross-space reference distinct', () => {
    const other = '<ac:link><ri:page ri:content-title="X" ri:space-key="OPS"/></ac:link>';
    const implicit = '<ac:link><ri:page ri:content-title="X"/></ac:link>';
    expect(normaliseStorage(implicit, { defaultSpaceKey: 'ENG' })).not.toBe(
      normaliseStorage(other, { defaultSpaceKey: 'ENG' }),
    );
  });

  it('falls back to whitespace collapsing for an unparseable body', () => {
    expect(normaliseStorage('<p>unclosed   text')).toBe('<p>unclosed text');
  });

  it('retains comments so losing one is visible', () => {
    expect(normaliseStorage('<p><!--keep--></p>')).toContain('keep');
  });
});

describe('markdownToStorage failures', () => {
  it('refuses to push when a referenced fragment is not cached', () => {
    const markdown = '```confluence-block\nid: cfb-0001\ntype: macro\n```\n';
    const result = markdownToStorage(markdown, EMPTY, OPTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FRAGMENT_MISSING');
      expect(result.error.action).toBe('repull-page');
      expect(result.error.userMessage).toContain('cfb-0001');
    }
  });

  it('refuses a placeholder fence with no readable id', () => {
    const result = markdownToStorage('```confluence-block\nnonsense\n```\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
  });

  it('reports an embedded image rather than dropping it', () => {
    const result = markdownToStorage('![alt](local.png)\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('image');
  });

  it('reports a reference-style link', () => {
    const result = markdownToStorage('[a][ref]\n\n[ref]: https://x\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
  });

  it('converts a plain document', () => {
    const result = markdownToStorage('# Title\n\nBody.\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('<h1>Title</h1><p>Body.</p>');
  });

  it('writes an external link as an anchor', () => {
    const result = markdownToStorage('[x](https://example.com)\n', EMPTY, OPTIONS);
    expect(result.ok && result.value).toContain('<a href="https://example.com">x</a>');
  });

  it('writes a link back into Confluence as an ac:link', () => {
    const result = markdownToStorage(
      '[Data Model](https://wiki.corp/display/ENG/Data+Model)\n',
      EMPTY,
      OPTIONS,
    );
    expect(result.ok && result.value).toContain('<ri:page ri:content-title="Data Model"');
  });
});

describe('firstDifference', () => {
  it('returns null for identical strings', () => {
    expect(firstDifference('same', 'same')).toBeNull();
  });

  it('reports where two strings diverge', () => {
    const detail = firstDifference('abcdef', 'abcXef');
    expect(detail).toContain('character 3');
  });

  it('handles one string being a prefix of the other', () => {
    expect(firstDifference('abc', 'abcdef')).toContain('character 3');
  });
});

describe('certify', () => {
  it('certifies content that reproduces exactly', () => {
    const result = certify('<h1>Title</h1><p>Body.</p>', OPTIONS);
    expect(result.ok && result.value.certified).toBe(true);
    expect(result.ok && result.value.detail).toBeNull();
  });

  it('returns the Markdown and fragments even when certification fails', () => {
    // Both <del> and <s> mean strikethrough and both convert to `~~text~~`, so
    // the reverse pass can only produce one of them. <del> cannot be reproduced.
    const result = certify('<p>A <del>removed</del> word.</p>', OPTIONS);

    expect(result.ok && result.value.certified).toBe(false);
    expect(result.ok && result.value.markdown).toContain('removed');
    expect(result.ok && result.value.detail).not.toBeNull();
  });

  it('certifies an inline comment marker, which is preserved as a pair', () => {
    const result = certify(
      '<p>A <ac:inline-comment-marker ac:ref="1">note</ac:inline-comment-marker>.</p>',
      OPTIONS,
    );

    expect(result.ok && result.value.certified).toBe(true);
    // The commented text stays readable rather than hidden behind a token.
    expect(result.ok && result.value.markdown).toContain('note');
  });

  it('propagates a parse failure instead of reporting a fidelity result', () => {
    const result = certify('<p>unclosed', OPTIONS);
    expect(result.ok).toBe(false);
  });
});

describe('verify', () => {
  it('verifies an edit that stays representable', () => {
    const result = verify('# Title\n\nEdited body.\n', EMPTY, OPTIONS);
    expect(result.ok && result.value.verified).toBe(true);
    expect(result.ok && result.value.storage).toContain('Edited body.');
  });

  it('fails when the note would not survive a round trip', () => {
    // Underscore emphasis converts to <em>, which comes back as asterisks.
    const result = verify('_emphasis_\n', EMPTY, OPTIONS);
    expect(result.ok && result.value.verified).toBe(false);
    expect(result.ok && result.value.roundTripped).toContain('*emphasis*');
  });

  it('surfaces a missing fragment as an error, not an unverified result', () => {
    const result = verify('```confluence-block\nid: cfb-0009\n```\n', EMPTY, OPTIONS);
    expect(result.ok).toBe(false);
  });
});

describe('storageToMarkdown determinism', () => {
  it('produces byte-identical output for the same input', () => {
    const input =
      '<h1>T</h1><ac:structured-macro ac:name="jira"><ac:parameter ac:name="q">x</ac:parameter></ac:structured-macro>';
    const first = storageToMarkdown(input, OPTIONS);
    const second = storageToMarkdown(input, OPTIONS);
    expect(first.ok && second.ok && first.value.markdown).toBe(
      second.ok ? second.value.markdown : '',
    );
  });
});
