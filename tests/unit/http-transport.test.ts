import { afterEach, describe, expect, it } from 'vitest';
import { ObsidianTransport, headerValue } from '../../src/api/http-transport';
import { resetRequestUrlHandler, setRequestUrlHandler } from '../fakes/obsidian';

/**
 * The real HTTP boundary. These tests cover the wrapper itself: that it passes
 * the request through faithfully, surfaces non-2xx statuses instead of throwing,
 * and classifies transport failures.
 */

const request = {
  url: 'https://wiki.corp/confluence/rest/api/space',
  method: 'GET' as const,
  headers: { Authorization: 'Bearer PAT' },
};

afterEach(resetRequestUrlHandler);

describe('headerValue', () => {
  it('finds a header regardless of casing', () => {
    const headers = { 'Retry-After': '5', 'Content-Type': 'application/json' };
    expect(headerValue(headers, 'retry-after')).toBe('5');
    expect(headerValue(headers, 'RETRY-AFTER')).toBe('5');
  });

  it('returns undefined when the header is absent', () => {
    expect(headerValue({}, 'retry-after')).toBeUndefined();
  });
});

describe('ObsidianTransport', () => {
  it('returns a successful response', async () => {
    setRequestUrlHandler(() =>
      Promise.resolve({ status: 200, headers: { a: 'b' }, text: '{"ok":true}' }),
    );
    const result = await new ObsidianTransport().send(request);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.status).toBe(200);
    expect(result.ok && result.value.text).toBe('{"ok":true}');
    expect(result.ok && result.value.headers).toEqual({ a: 'b' });
  });

  it('passes the url, method and headers through', async () => {
    let seen: unknown;
    setRequestUrlHandler((param) => {
      seen = param;
      return Promise.resolve({ status: 200, headers: {}, text: '' });
    });
    await new ObsidianTransport().send(request);

    expect(seen).toMatchObject({
      url: request.url,
      method: 'GET',
      headers: { Authorization: 'Bearer PAT' },
    });
  });

  it('asks Obsidian not to throw, so statuses can be mapped to typed errors', async () => {
    let seen: Record<string, unknown> = {};
    setRequestUrlHandler((param) => {
      seen = param as Record<string, unknown>;
      return Promise.resolve({ status: 200, headers: {}, text: '' });
    });
    await new ObsidianTransport().send(request);

    expect(seen['throw']).toBe(false);
  });

  it('omits the body entirely when there is none', async () => {
    let seen: Record<string, unknown> = {};
    setRequestUrlHandler((param) => {
      seen = param as Record<string, unknown>;
      return Promise.resolve({ status: 200, headers: {}, text: '' });
    });
    await new ObsidianTransport().send(request);

    expect('body' in seen).toBe(false);
  });

  it('forwards a body when one is supplied', async () => {
    let seen: Record<string, unknown> = {};
    setRequestUrlHandler((param) => {
      seen = param as Record<string, unknown>;
      return Promise.resolve({ status: 200, headers: {}, text: '' });
    });
    await new ObsidianTransport().send({ ...request, method: 'PUT', body: '{"a":1}' });

    expect(seen['body']).toBe('{"a":1}');
  });

  it('surfaces a non-2xx status as a successful call, not an error', async () => {
    // Status mapping belongs to the client, which turns it into a typed error
    // with a user-facing message. The transport must not swallow it.
    setRequestUrlHandler(() => Promise.resolve({ status: 401, headers: {}, text: 'nope' }));
    const result = await new ObsidianTransport().send(request);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.status).toBe(401);
  });

  it('classifies an untrusted certificate', async () => {
    setRequestUrlHandler(() => Promise.reject(new Error('unable to verify the first certificate')));
    const result = await new ObsidianTransport().send(request);

    expect(!result.ok && result.error.code).toBe('TLS_UNTRUSTED');
    expect(!result.ok && result.error.userMessage).toContain('trust store');
  });

  it('classifies a connectivity failure', async () => {
    setRequestUrlHandler(() => Promise.reject(new Error('getaddrinfo ENOTFOUND wiki.corp')));
    const result = await new ObsidianTransport().send(request);

    expect(!result.ok && result.error.code).toBe('NETWORK_UNREACHABLE');
  });

  it('never throws, whatever the failure', async () => {
    setRequestUrlHandler(() => Promise.reject('a bare string'));
    await expect(new ObsidianTransport().send(request)).resolves.toMatchObject({ ok: false });
  });
});
