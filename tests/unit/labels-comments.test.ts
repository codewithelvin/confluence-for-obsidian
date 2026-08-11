import { describe, expect, it } from 'vitest';
import { parseComment, parsePage, parseUploadedAttachment } from '../../src/api/api-types';
import { multipartBody } from '../../src/api/request-runner';
import { commentText } from '../../src/convert/comment-text';
import { syncComments } from '../../src/sync/comments-executor';
import { diffLabels, isRepresentableLabel, labelsAfter, toLabel } from '../../src/sync/labels';
import {
  COMMENTS_BEGIN,
  COMMENTS_END,
  renderCommentsRegion,
  stripManagedRegions,
  withManagedRegions,
} from '../../src/sync/managed-regions';
import type { PullItem } from '../../src/sync/pull-planner';
import { applyTags, commentsDisabled, readTags } from '../../src/vault/frontmatter';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeVaultGateway } from '../fakes/sync';

/**
 * Labels and comments (spec FR-9.1 to FR-9.6, §16 O5), and the multipart body
 * behind FR-8.6.
 *
 * The invariant running through the label half: **the plugin only ever removes what
 * it put there.** Every other tag in a note is the user's, and a rule that cannot
 * tell the difference deletes their work on the next sync.
 */

const LOGGER = new Logger('test', () => false);

function pullItem(path = 'ENG/Architecture.md'): PullItem {
  return {
    page: {
      id: '1',
      title: 'Architecture',
      spaceKey: 'ENG',
      version: 3,
      parentId: null,
      updatedAt: '2026-08-09T14:03:11Z',
      updatedBy: 'j.smith',
    },
    path,
    isFolderNote: false,
    isNew: false,
    alias: null,
    previousAlias: null,
    previousLabels: [],
  };
}

describe('label representability (FR-9.2)', () => {
  it('accepts the shapes a Confluence label can hold', () => {
    for (const tag of ['architecture', 'api-v2', 'release_2026', 'project/alpha', '2026']) {
      expect(isRepresentableLabel(tag)).toBe(true);
    }
  });

  it('refuses tags Confluence would split or namespace', () => {
    // A space or a comma arrives as several labels; a colon is a prefix separator.
    for (const tag of ['two words', 'a,b', 'team:core', '', 'say "no"']) {
      expect(isRepresentableLabel(tag)).toBe(false);
    }
  });

  it('sends the lower-cased form Confluence will store', () => {
    expect(toLabel('Architecture')).toBe('architecture');
  });
});

describe('diffLabels (FR-9.2)', () => {
  it('adds a tag the user typed', () => {
    expect(diffLabels(['api', 'architecture'], ['api'])).toEqual({
      add: ['architecture'],
      remove: [],
      unrepresentable: [],
    });
  });

  it('removes a label whose tag the user deleted', () => {
    expect(diffLabels(['api'], ['api', 'architecture'])).toEqual({
      add: [],
      remove: ['architecture'],
      unrepresentable: [],
    });
  });

  it('treats a re-cased tag as the same label', () => {
    // Confluence stores labels lower-cased, so `Architecture` and `architecture` are
    // one label. Anything else would delete it and add it back on every push.
    expect(diffLabels(['Architecture'], ['architecture'])).toEqual({
      add: [],
      remove: [],
      unrepresentable: [],
    });
  });

  it('reports a tag it cannot send, and neither sends nor removes anything for it', () => {
    const diff = diffLabels(['two words'], []);

    expect(diff.unrepresentable).toEqual(['two words']);
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
  });

  it('sends nothing for a note whose recorded labels are unknown', () => {
    // The case that matters most: a page mirrored before labels were synced records
    // none, so its first push must not strip the labels the page already has.
    expect(diffLabels([], []).remove).toEqual([]);
  });

  it('asks for a label once even when two tags differ only in case', () => {
    expect(diffLabels(['API', 'api'], []).add).toEqual(['api']);
  });

  it('reports the set the page holds afterwards', () => {
    const diff = diffLabels(['api', 'new'], ['api', 'gone']);
    expect(labelsAfter(['api', 'gone'], diff)).toEqual(['api', 'new']);
  });
});

describe('tags in frontmatter (FR-9.1)', () => {
  it('reads a list, a bare string and a numeric entry', () => {
    expect(readTags({ tags: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(readTags({ tags: '#a b' })).toEqual(['a', 'b']);
    expect(readTags({ tags: [2026] })).toEqual(['2026']);
    expect(readTags({ tags: { not: 'a list' } })).toEqual([]);
    expect(readTags('not frontmatter')).toEqual([]);
  });

  it('keeps the user’s tags and adds the page’s labels', () => {
    const frontmatter: Record<string, unknown> = { tags: ['mine'] };
    applyTags(frontmatter, ['api'], []);

    expect(frontmatter['tags']).toEqual(['mine', 'api']);
  });

  it('removes only a label it wrote last time', () => {
    const frontmatter: Record<string, unknown> = { tags: ['mine', 'api', 'gone'] };
    applyTags(frontmatter, ['api'], ['api', 'gone']);

    expect(frontmatter['tags']).toEqual(['mine', 'api']);
  });

  it('leaves a user tag that differs from a label only in case', () => {
    const frontmatter: Record<string, unknown> = { tags: ['Architecture'] };
    applyTags(frontmatter, ['architecture'], []);

    expect(frontmatter['tags']).toEqual(['Architecture']);
  });

  it('deletes the key rather than writing an empty list', () => {
    const frontmatter: Record<string, unknown> = { tags: ['api'] };
    applyTags(frontmatter, [], ['api']);

    expect('tags' in frontmatter).toBe(false);
  });

  it('is stable across two identical syncs', () => {
    const frontmatter: Record<string, unknown> = { tags: ['mine'] };
    applyTags(frontmatter, ['api'], []);
    const first = [...(frontmatter['tags'] as string[])];
    applyTags(frontmatter, ['api'], ['api']);

    expect(frontmatter['tags']).toEqual(first);
  });
});

describe('the per-page comments opt-out (FR-9.6, §16 O5)', () => {
  it('recognises false and the quoted form somebody types by hand', () => {
    expect(commentsDisabled({ confluenceComments: false })).toBe(true);
    expect(commentsDisabled({ confluenceComments: 'false' })).toBe(true);
  });

  it('leaves the decision to the subscription otherwise', () => {
    expect(commentsDisabled({ confluenceComments: true })).toBe(false);
    expect(commentsDisabled({})).toBe(false);
    expect(commentsDisabled(undefined)).toBe(false);
  });
});

describe('commentText (FR-9.3)', () => {
  it('breaks a line at every block boundary', () => {
    expect(commentText('<p>First.</p><p>Second.</p>')).toEqual(['First.', 'Second.']);
  });

  it('follows a break and collapses the whitespace around it', () => {
    expect(commentText('<p>One<br/>  Two  </p>')).toEqual(['One', 'Two']);
  });

  it('keeps the text inside inline markup', () => {
    expect(commentText('<p>A <strong>bold</strong> claim</p>')).toEqual(['A bold claim']);
  });

  it('reads a list as one line per item', () => {
    expect(commentText('<ul><li>one</li><li>two</li></ul>')).toEqual(['one', 'two']);
  });

  it('has nothing to show for a body that is only a picture', () => {
    expect(commentText('<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>')).toEqual(
      [],
    );
  });

  it('falls back to stripping tags when the body will not parse', () => {
    // A colleague's words matter more than the parse error: refusing would hide the
    // remark behind a failure the reader cannot act on.
    expect(commentText('<p>Unclosed & broken')).toEqual(['Unclosed & broken']);
  });
});

describe('the comments region (§6.7, FR-9.3, FR-9.4)', () => {
  const comment = {
    author: 'j.smith',
    createdAt: '2026-08-09T14:03:11Z',
    text: ['Looks good, but should we mention the retry policy?'],
    inlineRef: null,
  };

  it('writes §6.7’s callout, and says it is replaced', () => {
    const region = renderCommentsRegion([comment]);

    expect(region.startsWith(COMMENTS_BEGIN)).toBe(true);
    expect(region.endsWith(COMMENTS_END)).toBe(true);
    expect(region).toContain('> [!quote]- Comments (1)');
    // FR-9.4 asks for the discarding of local edits to be documented where the user
    // meets it, which is here rather than on a settings screen.
    expect(region).toContain('replaced on every sync');
    expect(region).toContain('> **j.smith** — 2026-08-09 14:03');
    expect(region).toContain('> Looks good, but should we mention the retry policy?');
  });

  it('renders no region at all for a page with no comments', () => {
    expect(renderCommentsRegion([])).toBe('');
  });

  it('names the anchor an inline comment is attached to', () => {
    expect(renderCommentsRegion([{ ...comment, inlineRef: 'abc-123' }])).toContain('(on abc-123)');
  });

  it('still attributes a comment whose body showed nothing', () => {
    expect(renderCommentsRegion([{ ...comment, text: [] }])).toContain('*(no text)*');
  });

  it('does not reinterpret a timestamp the server did not format', () => {
    expect(renderCommentsRegion([{ ...comment, createdAt: 'yesterday' }])).toContain('yesterday');
    expect(renderCommentsRegion([{ ...comment, createdAt: '' }])).toContain('> **j.smith**\n');
  });

  it('round-trips: appending a region and stripping it gives the body back', () => {
    // The property §6.7 rests on. If it failed, a page with comments would hash
    // differently from the same page without and look permanently modified.
    const body = 'Some prose.';
    expect(stripManagedRegions(withManagedRegions(body, renderCommentsRegion([comment])))).toBe(
      body,
    );
  });

  it('appends nothing for an empty region', () => {
    expect(withManagedRegions('Some prose.', '')).toBe('Some prose.');
  });
});

describe('syncComments (FR-9.5, FR-9.6)', () => {
  function deps(vault: FakeVaultGateway, client: FakeConfluence, enabled = true) {
    return { client, vault, logger: LOGGER, enabled };
  }

  it('renders the page’s comments, oldest first', async () => {
    const client = new FakeConfluence();
    client.comments.set('1', [
      {
        id: 'c2',
        author: 'b',
        createdAt: '2026-08-10T09:00:00Z',
        storage: '<p>Second</p>',
        location: 'footer',
        inlineRef: null,
      },
      {
        id: 'c1',
        author: 'a',
        createdAt: '2026-08-09T09:00:00Z',
        storage: '<p>First</p>',
        location: 'footer',
        inlineRef: null,
      },
    ]);

    const outcome = await syncComments(deps(new FakeVaultGateway(), client), pullItem());

    expect(outcome.comments).toBe(2);
    expect(outcome.region.indexOf('First')).toBeLessThan(outcome.region.indexOf('Second'));
  });

  it('fetches nothing when the subscription has comments off', async () => {
    const client = new FakeConfluence();
    client.comments.set('1', [
      {
        id: 'c1',
        author: 'a',
        createdAt: '',
        storage: '<p>x</p>',
        location: 'footer',
        inlineRef: null,
      },
    ]);

    const outcome = await syncComments(deps(new FakeVaultGateway(), client, false), pullItem());

    expect(outcome).toEqual({ region: '', comments: 0, failures: [] });
  });

  it('honours one note’s opt-out while the subscription stays on', async () => {
    const vault = new FakeVaultGateway();
    vault.commentsOptOut.add('ENG/Architecture.md');

    const client = new FakeConfluence();
    client.comments.set('1', [
      {
        id: 'c1',
        author: 'a',
        createdAt: '',
        storage: '<p>x</p>',
        location: 'footer',
        inlineRef: null,
      },
    ]);

    const outcome = await syncComments(deps(vault, client), pullItem());
    expect(outcome.region).toBe('');
  });

  it('reports a failure and writes no region, rather than failing the page', async () => {
    const client = new FakeConfluence();
    client.commentError = new (await import('../../src/util/errors')).AppError(
      'NETWORK_UNREACHABLE',
      'no route',
    );

    const outcome = await syncComments(deps(new FakeVaultGateway(), client), pullItem());

    expect(outcome.region).toBe('');
    expect(outcome.failures).toHaveLength(1);
  });
});

describe('parsing labels and comments', () => {
  it('reads label names off an expanded page', () => {
    const page = parsePage({
      id: '1',
      title: 'A',
      body: { storage: { value: '<p>x</p>' } },
      metadata: {
        labels: { results: [{ name: 'api' }, { prefix: 'global', name: 'architecture' }] },
      },
    });

    expect(page.ok && page.value.labels).toEqual(['api', 'architecture']);
  });

  it('treats a page with no expansion as having no labels', () => {
    const page = parsePage({ id: '1', title: 'A', body: { storage: { value: '' } } });
    expect(page.ok && page.value.labels).toEqual([]);
  });

  it('skips a label entry it cannot read rather than failing the body', () => {
    const page = parsePage({
      id: '1',
      title: 'A',
      body: { storage: { value: '<p>x</p>' } },
      metadata: { labels: { results: [{ name: '' }, 'nonsense', { name: 'api' }] } },
    });

    expect(page.ok && page.value.labels).toEqual(['api']);
  });

  it('attributes a comment to its creator, not its last editor', () => {
    const comment = parseComment({
      id: 'c1',
      body: { storage: { value: '<p>hi</p>' } },
      history: { createdBy: { displayName: 'Jane Smith' }, createdDate: '2026-08-09T14:03:11Z' },
      version: { by: { displayName: 'Someone Else' }, when: '2026-08-11T00:00:00Z' },
      extensions: { location: 'inline', inlineProperties: { ref: 'abc' } },
    });

    expect(comment.ok && comment.value).toMatchObject({
      author: 'Jane Smith',
      createdAt: '2026-08-09T14:03:11Z',
      location: 'inline',
      inlineRef: 'abc',
    });
  });

  it('falls back to the version’s author, and to footer, when history is absent', () => {
    const comment = parseComment({
      id: 'c1',
      body: { storage: { value: '<p>hi</p>' } },
      version: { by: { displayName: 'Jane' }, when: '2026-08-11T00:00:00Z' },
    });

    expect(comment.ok && comment.value).toMatchObject({
      author: 'Jane',
      createdAt: '2026-08-11T00:00:00Z',
      location: 'footer',
      inlineRef: null,
    });
  });

  it('refuses a comment with no body', () => {
    expect(parseComment({ id: 'c1' }).ok).toBe(false);
    expect(parseComment('nonsense').ok).toBe(false);
  });

  it('unwraps the collection an upload answers with', () => {
    const attachment = parseUploadedAttachment({
      results: [{ id: 'att1', title: 'a.png', _links: { download: '/download/a.png' } }],
    });

    expect(attachment.ok && attachment.value.filename).toBe('a.png');
  });

  it('refuses an upload response with nothing in it', () => {
    // The caller is about to publish a body naming this file; no proof means no push.
    expect(parseUploadedAttachment({ results: [] }).ok).toBe(false);
  });
});

describe('multipartBody (FR-8.6)', () => {
  const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

  function assembled(filename: string) {
    const buffer = new ArrayBuffer(BYTES.length);
    new Uint8Array(buffer).set(BYTES);
    return multipartBody(filename, buffer, 'BOUNDARY');
  }

  it('names the part and declares the boundary', () => {
    const body = assembled('diagram.png');
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    expect(body.value.contentType).toBe('multipart/form-data; boundary=BOUNDARY');

    const text = new TextDecoder('latin1').decode(body.value.content as ArrayBuffer);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="diagram.png"');
    expect(text).toContain('name="minorEdit"');
    expect(text.endsWith('--BOUNDARY--\r\n')).toBe(true);
  });

  it('carries the file’s bytes through untouched', () => {
    const body = assembled('diagram.png');
    if (!body.ok) throw new Error('expected a body');

    const bytes = new Uint8Array(body.value.content as ArrayBuffer);
    const start = bytes.indexOf(0x89);
    expect([...bytes.slice(start, start + BYTES.length)]).toEqual([...BYTES]);
  });

  it('refuses a name that would inject a header', () => {
    expect(assembled('a"b.png').ok).toBe(false);
    expect(assembled('a\r\nb.png').ok).toBe(false);
    expect(assembled('').ok).toBe(false);
  });
});
