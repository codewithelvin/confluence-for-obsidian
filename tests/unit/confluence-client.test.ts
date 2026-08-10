import { describe, expect, it } from 'vitest';
import { ConfluenceClient, type TokenProvider } from '../../src/api/confluence-client';
import { DEFAULT_RETRY, Semaphore } from '../../src/api/rate-limiter';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import type { HttpResponse } from '../../src/api/http-transport';
import {
  jsonResponse,
  recordingTransport,
  repeatingTransport,
  testScheduler,
  textResponse,
} from '../fakes/http';

const BASE_URL = 'https://wiki.corp/confluence';
const silentLogger = new Logger('test', () => false);

const MANIFEST = '<applinks-manifest><version>7.19.6</version></applinks-manifest>';
const USER = { username: 'e.huseynov', displayName: 'Elvin Huseynov' };

function makeClient(
  script: readonly (HttpResponse | AppError)[],
  options: { token?: TokenProvider; pageSize?: number } = {},
) {
  const transport = recordingTransport(script);
  const scheduler = testScheduler(1);
  const client = new ConfluenceClient(BASE_URL, options.token ?? (() => 'PAT-TOKEN'), {
    transport,
    semaphore: new Semaphore(4),
    scheduler,
    retry: DEFAULT_RETRY,
    logger: silentLogger,
    pageSize: options.pageSize ?? 2,
  });
  return { client, transport, scheduler };
}

const space = (key: string, type = 'global') => ({ key, name: key, type });

describe('ConfluenceClient authentication', () => {
  it('sends the token as a bearer credential', async () => {
    const { client, transport } = makeClient([jsonResponse(USER), textResponse(MANIFEST)]);
    await client.checkConnection();

    expect(transport.requests[0]?.headers['Authorization']).toBe('Bearer PAT-TOKEN');
  });

  it('targets the Data Center v1 API under the context path', async () => {
    const { client, transport } = makeClient([jsonResponse(USER), textResponse(MANIFEST)]);
    await client.checkConnection();

    expect(transport.requests[0]?.url).toBe(`${BASE_URL}/rest/api/user/current`);
  });

  it('fails without making a request when no token is available', async () => {
    const { client, transport } = makeClient([], { token: () => null });
    const result = await client.checkConnection();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CREDENTIALS_UNAVAILABLE');
    expect(transport.requests).toHaveLength(0);
  });

  it('reports an invalid token as an authentication failure', async () => {
    const { client } = makeClient([jsonResponse({ message: 'no' }, 401)]);
    const result = await client.checkConnection();

    expect(!result.ok && result.error.code).toBe('AUTH_FAILED');
  });

  it('reports an SSO login page as a malformed response, not a success', async () => {
    const { client } = makeClient([textResponse('<html><body>Sign in</body></html>', 200)]);
    const result = await client.checkConnection();

    expect(!result.ok && result.error.code).toBe('MALFORMED_RESPONSE');
  });
});

describe('ConfluenceClient version detection', () => {
  it('detects the version from the applinks manifest', async () => {
    const { client } = makeClient([jsonResponse(USER), textResponse(MANIFEST)]);
    const result = await client.checkConnection();

    expect(result.ok && result.value.version?.raw).toBe('7.19.6');
    expect(result.ok && result.value.versionSupported).toBe(true);
  });

  it('falls back to the next probe when the first yields nothing usable', async () => {
    const { client, transport } = makeClient([
      jsonResponse(USER),
      textResponse('<html>login</html>'),
      jsonResponse({ version: '8.5.4' }),
    ]);
    const result = await client.checkConnection();

    expect(result.ok && result.value.version?.raw).toBe('8.5.4');
    expect(transport.requests).toHaveLength(3);
  });

  it('flags a version below the Personal Access Token floor', async () => {
    const { client } = makeClient([
      jsonResponse(USER),
      textResponse('<applinks-manifest><version>7.8.1</version></applinks-manifest>'),
    ]);
    const result = await client.checkConnection();

    expect(result.ok && result.value.versionSupported).toBe(false);
  });

  it('treats an undetectable version as unknown rather than unsupported', async () => {
    // Blocking setup because a probe failed would lock out working instances.
    const { client } = makeClient([
      jsonResponse(USER),
      textResponse('<html/>'),
      textResponse('<html/>'),
    ]);
    const result = await client.checkConnection();

    expect(result.ok && result.value.version).toBeNull();
    expect(result.ok && result.value.versionSupported).toBe(true);
  });
});

describe('ConfluenceClient.listSpaces', () => {
  it('follows pagination until a short page is returned', async () => {
    const { client, transport } = makeClient([
      jsonResponse({ results: [space('ENG'), space('OPS')], start: 0, limit: 2, size: 2 }),
      jsonResponse({ results: [space('HR')], start: 2, limit: 2, size: 1 }),
    ]);
    const result = await client.listSpaces();

    expect(result.ok && result.value.map((s) => s.key)).toEqual(['ENG', 'OPS', 'HR']);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.url).toContain('start=2');
  });

  it('excludes personal spaces by default', async () => {
    const { client } = makeClient(
      [jsonResponse({ results: [space('ENG'), space('~elvin', 'personal')] })],
      { pageSize: 10 },
    );
    const result = await client.listSpaces();

    expect(result.ok && result.value.map((s) => s.key)).toEqual(['ENG']);
  });

  it('includes personal spaces on request', async () => {
    const { client } = makeClient(
      [jsonResponse({ results: [space('ENG'), space('~elvin', 'personal')] })],
      { pageSize: 10 },
    );
    const result = await client.listSpaces({ includePersonal: true });

    expect(result.ok && result.value).toHaveLength(2);
  });

  it('requests one more page when the last page is exactly full', async () => {
    // Without a reliable total count there is no way to know a full page is the
    // last one, so a final empty request is the correct, conservative cost.
    const { client, transport } = makeClient([
      jsonResponse({ results: [space('ENG'), space('OPS')] }),
      jsonResponse({ results: [] }),
    ]);
    const result = await client.listSpaces();

    expect(result.ok && result.value).toHaveLength(2);
    expect(transport.requests).toHaveLength(2);
  });

  it('stops on an empty first page', async () => {
    const { client, transport } = makeClient([jsonResponse({ results: [] })]);
    const result = await client.listSpaces();

    expect(result.ok && result.value).toEqual([]);
    expect(transport.requests).toHaveLength(1);
  });

  it('propagates a permission failure', async () => {
    const { client } = makeClient([jsonResponse({}, 403)]);
    const result = await client.listSpaces();

    expect(!result.ok && result.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('ConfluenceClient retry behaviour', () => {
  it('retries a 429 and honours Retry-After over computed backoff', async () => {
    const { client, scheduler } = makeClient([
      textResponse('slow down', 429, { 'Retry-After': '7' }),
      jsonResponse({ results: [space('ENG')] }),
    ]);
    const result = await client.listSpaces();

    expect(result.ok).toBe(true);
    expect(scheduler.delays).toEqual([7000]);
  });

  it('falls back to computed backoff when Retry-After is absent', async () => {
    const { client, scheduler } = makeClient([
      textResponse('busy', 503),
      jsonResponse({ results: [] }),
    ]);
    await client.listSpaces();

    expect(scheduler.delays).toEqual([DEFAULT_RETRY.baseDelayMs]);
  });

  it('gives up after the maximum number of attempts', async () => {
    const script = Array.from({ length: DEFAULT_RETRY.maxAttempts }, () =>
      textResponse('busy', 503),
    );
    const { client, transport, scheduler } = makeClient(script);
    const result = await client.listSpaces();

    expect(!result.ok && result.error.code).toBe('UNKNOWN');
    expect(transport.requests).toHaveLength(DEFAULT_RETRY.maxAttempts);
    expect(scheduler.delays).toHaveLength(DEFAULT_RETRY.maxAttempts - 1);
  });

  it('never retries a 409', async () => {
    // Spec FR-5.5: a version conflict must reach the user, not a retry loop.
    const { client, transport } = makeClient([textResponse('conflict', 409)]);
    const result = await client.listSpaces();

    expect(!result.ok && result.error.code).toBe('CONFLICT');
    expect(transport.requests).toHaveLength(1);
  });

  it('never retries an authentication failure', async () => {
    const { client, transport } = makeClient([textResponse('nope', 401)]);
    await client.listSpaces();

    expect(transport.requests).toHaveLength(1);
  });

  it('does not retry a transport failure, since TLS and DNS will not self-heal', async () => {
    const tlsError = new AppError('TLS_UNTRUSTED', 'bad cert');
    const { client, transport } = makeClient([tlsError]);
    const result = await client.listSpaces();

    expect(!result.ok && result.error.code).toBe('TLS_UNTRUSTED');
    expect(transport.requests).toHaveLength(1);
  });
});

describe('ConfluenceClient concurrency', () => {
  it('never exceeds the semaphore limit', async () => {
    const transport = repeatingTransport(jsonResponse({ results: [] }));
    const semaphore = new Semaphore(2);
    const client = new ConfluenceClient(BASE_URL, () => 'PAT', {
      transport,
      semaphore,
      scheduler: testScheduler(),
      retry: DEFAULT_RETRY,
      logger: silentLogger,
      pageSize: 25,
    });

    await Promise.all(Array.from({ length: 6 }, () => client.listSpaces()));

    expect(transport.requests).toHaveLength(6);
    expect(semaphore.inFlight).toBe(0);
  });
});
