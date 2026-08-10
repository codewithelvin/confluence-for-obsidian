import { describe, expect, it } from 'vitest';
import { parsePageRef, parsePaged } from '../../src/api/api-types';
import { ConfluenceClient, type TokenProvider } from '../../src/api/confluence-client';
import { quoteCql, subtreeCql } from '../../src/api/cql';
import { MAX_COLLECTED, collectAllPages } from '../../src/api/pagination';
import { DEFAULT_RETRY, Semaphore } from '../../src/api/rate-limiter';
import { AppError } from '../../src/util/errors';
import type { HttpResponse } from '../../src/api/http-transport';
import { Logger } from '../../src/util/logger';
import { ok } from '../../src/util/result';
import { jsonResponse, recordingTransport, testScheduler } from '../fakes/http';

const BASE_URL = 'https://wiki.corp/confluence';
const silentLogger = new Logger('test', () => false);

function makeClient(script: readonly (HttpResponse | AppError)[], pageSize = 2) {
  const transport = recordingTransport(script);
  const token: TokenProvider = () => 'PAT';
  const client = new ConfluenceClient(BASE_URL, token, {
    transport,
    semaphore: new Semaphore(4),
    scheduler: testScheduler(1),
    retry: DEFAULT_RETRY,
    logger: silentLogger,
    pageSize,
  });
  return { client, transport };
}

function page(id: string, title: string, ancestors: readonly { id: string }[] = []) {
  return {
    id,
    title,
    space: { key: 'ENG' },
    version: { number: 3, when: '2026-08-09T14:03:11Z', by: { username: 'j.smith' } },
    ancestors,
  };
}

describe('quoteCql', () => {
  it('quotes an ordinary value', () => {
    expect(quoteCql('ENG')).toBe('"ENG"');
  });

  it('escapes backslashes before quotes, not after', () => {
    // Doing it the other way round escapes the backslashes that escaping the
    // quotes just introduced, doubling them.
    expect(quoteCql('a"b')).toBe('"a\\"b"');
    expect(quoteCql('a\\b')).toBe('"a\\\\b"');
    expect(quoteCql('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

describe('subtreeCql', () => {
  it('scopes a whole-space subscription to pages', () => {
    expect(subtreeCql('ENG', null)).toBe('space = "ENG" AND type = page');
  });

  it('includes the root page as well as its descendants', () => {
    // `ancestor` matches only what is below a page, so omitting `id` would
    // subscribe to a subtree whose own top page never syncs.
    const cql = subtreeCql('ENG', '123');
    expect(cql).toContain('id = "123"');
    expect(cql).toContain('ancestor = "123"');
  });
});

describe('parsePageRef', () => {
  it('takes the last ancestor as the parent', () => {
    // Confluence returns the chain root-first; taking the first would reparent
    // every page to the top of the space and flatten the hierarchy.
    const parsed = parsePageRef(page('3', 'C', [{ id: '1' }, { id: '2' }]));

    expect(parsed.ok && parsed.value.parentId).toBe('2');
  });

  it('reads the version, editor and timestamp', () => {
    const parsed = parsePageRef(page('1', 'A'));

    expect(parsed.ok && parsed.value.version).toBe(3);
    expect(parsed.ok && parsed.value.updatedBy).toBe('j.smith');
    expect(parsed.ok && parsed.value.updatedAt).toBe('2026-08-09T14:03:11Z');
  });

  it('treats a top-level page as having no parent', () => {
    const parsed = parsePageRef(page('1', 'A'));
    expect(parsed.ok && parsed.value.parentId).toBeNull();
  });

  it('rejects a response with no page id', () => {
    expect(parsePageRef({ title: 'A' }).ok).toBe(false);
    expect(parsePageRef('nonsense').ok).toBe(false);
  });
});

describe('parsePaged totalSize', () => {
  it('reads a reported total', () => {
    const parsed = parsePaged({ results: [], totalSize: 240 }, parsePageRef);
    expect(parsed.ok && parsed.value.totalSize).toBe(240);
  });

  it('reports an unreported total as unknown rather than zero', () => {
    const parsed = parsePaged({ results: [] }, parsePageRef);
    expect(parsed.ok && parsed.value.totalSize).toBeNull();
  });
});

describe('collectAllPages', () => {
  const pageOf = (results: number[], limit: number) =>
    Promise.resolve(
      ok({ results, start: 0, limit, size: results.length, totalSize: null, nextPath: null }),
    );

  it('stops on the first short page', async () => {
    let calls = 0;
    const result = await collectAllPages((_, limit) => {
      calls += 1;
      return pageOf(calls === 1 ? [1, 2] : [3], limit);
    }, 2);

    expect(result.ok && result.value).toEqual([1, 2, 3]);
    expect(calls).toBe(2);
  });

  it('reports progress as pages arrive', async () => {
    const seen: number[] = [];
    await collectAllPages((start, limit) => pageOf(start === 0 ? [1, 2] : [3], limit), 2, {
      onProgress: (collected) => seen.push(collected),
    });

    expect(seen).toEqual([2, 3]);
  });

  it('stops between pages when cancelled', async () => {
    let calls = 0;
    const result = await collectAllPages(
      (_, limit) => {
        calls += 1;
        return pageOf([1, 2], limit);
      },
      2,
      { isCancelled: () => true },
    );

    expect(calls).toBe(1);
    expect(result.ok && result.value).toEqual([1, 2]);
  });

  it('gives up rather than looping forever on a server that ignores start', async () => {
    // A server that returns a full page whatever `start` says would otherwise
    // never end the walk.
    const result = await collectAllPages(
      (_, limit) =>
        pageOf(
          Array.from({ length: limit }, () => 1),
          limit,
        ),
      1000,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.userMessage).toContain(String(MAX_COLLECTED));
  });

  it('passes a failure straight through', async () => {
    const failure = new AppError('AUTH_FAILED', 'nope');
    const result = await collectAllPages(() => Promise.resolve({ ok: false, error: failure }), 2);

    expect(!result.ok && result.error).toBe(failure);
  });
});

describe('ConfluenceClient subtree enumeration', () => {
  it('walks a whole space through the content endpoint', async () => {
    const { client, transport } = makeClient([
      jsonResponse({ results: [page('1', 'A'), page('2', 'B')] }),
      jsonResponse({ results: [page('3', 'C', [{ id: '1' }])] }),
    ]);

    const result = await client.listSubtree('ENG', null);

    expect(result.ok && result.value.map((ref) => ref.id)).toEqual(['1', '2', '3']);
    expect(transport.requests[0]?.url).toContain('/rest/api/content?');
    expect(transport.requests[0]?.url).toContain('expand=version%2Cancestors%2Cspace');
  });

  it('uses CQL search for a subtree subscription', async () => {
    const { client, transport } = makeClient([jsonResponse({ results: [page('1', 'A')] })]);

    await client.listSubtree('ENG', '123');

    expect(transport.requests[0]?.url).toContain('/rest/api/content/search?');
    // Query encoding turns spaces into `+`, which decodeURIComponent leaves alone.
    const query = decodeURIComponent((transport.requests[0]?.url ?? '').replace(/\+/g, ' '));
    expect(query).toContain('ancestor = "123"');
  });

  it('asks for versions and ancestry but never for bodies', async () => {
    // Fetching 500 bodies to discover that three changed would blow the §7.1
    // sync budget on enumeration alone.
    const { client, transport } = makeClient([jsonResponse({ results: [] })]);
    await client.listSubtree('ENG', null);

    expect(transport.requests[0]?.url).not.toContain('body.storage');
  });

  it('counts a subtree without downloading it', async () => {
    const { client, transport } = makeClient([jsonResponse({ results: [], totalSize: 240 })]);

    const count = await client.countSubtree('ENG', null);

    expect(count.ok && count.value).toBe(240);
    expect(transport.requests[0]?.url).toContain('limit=1');
  });

  it('reports an unknown total as unknown', async () => {
    const { client } = makeClient([jsonResponse({ results: [] })]);
    const count = await client.countSubtree('ENG', null);

    expect(count.ok && count.value).toBeNull();
  });

  it('passes an enumeration failure through', async () => {
    const { client } = makeClient([jsonResponse({}, 401)]);
    const result = await client.listSubtree('ENG', null);

    expect(!result.ok && result.error.code).toBe('AUTH_FAILED');
  });

  it('requests the body when fetching one page', async () => {
    const { client, transport } = makeClient([
      jsonResponse({ ...page('1', 'A'), body: { storage: { value: '<p>x</p>' } } }),
    ]);

    const result = await client.getPage('1');

    expect(result.ok && result.value.storage).toBe('<p>x</p>');
    expect(transport.requests[0]?.url).toContain('body.storage');
  });
});
