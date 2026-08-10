import { describe, expect, it } from 'vitest';
import {
  AppError,
  errorFromStatus,
  errorFromTransportFailure,
  isAppError,
} from '../../src/util/errors';

describe('AppError', () => {
  it('carries a code, a user-facing message and a default action', () => {
    const error = new AppError('NOT_FOUND', 'Nothing there.');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.userMessage).toBe('Nothing there.');
    expect(error.action).toBe('none');
    expect(error.status).toBeUndefined();
    expect(error.message).toBe('Nothing there.');
  });

  it('is a real Error, so stack traces and instanceof work', () => {
    const error = new AppError('UNKNOWN', 'x');
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('preserves an underlying cause', () => {
    const cause = new Error('socket hang up');
    expect(new AppError('NETWORK_UNREACHABLE', 'x', { cause }).cause).toBe(cause);
  });
});

describe('errorFromStatus', () => {
  it('maps 401 to an actionable authentication failure', () => {
    const error = errorFromStatus(401, 'current user');
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.action).toBe('open-settings');
    // The user must never see a bare status code.
    expect(error.userMessage).toContain('Personal Access Token');
  });

  it('distinguishes permission denied from authentication failure', () => {
    expect(errorFromStatus(403, 'a page').code).toBe('PERMISSION_DENIED');
  });

  it('maps 409 to CONFLICT rather than something retryable', () => {
    // Spec FR-5.5: a stale-version push must enter the conflict flow, never a
    // retry loop that would overwrite a colleague's edit.
    const error = errorFromStatus(409, 'update page');
    expect(error.code).toBe('CONFLICT');
    expect(error.action).toBe('none');
  });

  it('maps 429 to a retryable rate limit', () => {
    const error = errorFromStatus(429, 'x');
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.action).toBe('retry');
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(errorFromStatus(404, 'page 12').code).toBe('NOT_FOUND');
  });

  it('treats 5xx as retryable', () => {
    expect(errorFromStatus(500, 'x').action).toBe('retry');
    expect(errorFromStatus(503, 'x').action).toBe('retry');
  });

  it('falls back to UNKNOWN for unhandled statuses and keeps the status', () => {
    const error = errorFromStatus(418, 'x');
    expect(error.code).toBe('UNKNOWN');
    expect(error.status).toBe(418);
  });

  it('names the failing operation so the message is diagnosable', () => {
    expect(errorFromStatus(403, 'listing spaces').userMessage).toContain('listing spaces');
  });
});

describe('errorFromTransportFailure', () => {
  it.each([
    'unable to verify the first certificate',
    'self signed certificate in certificate chain',
    'Error: CERT_HAS_EXPIRED',
    'SSL handshake failed',
  ])('recognises a TLS problem: %s', (message) => {
    const error = errorFromTransportFailure(new Error(message));
    expect(error.code).toBe('TLS_UNTRUSTED');
    // The remedy is the OS trust store — the plugin never offers a bypass.
    expect(error.userMessage).toContain('trust store');
    expect(error.action).toBe('open-docs');
  });

  it('treats other failures as connectivity problems', () => {
    const error = errorFromTransportFailure(new Error('getaddrinfo ENOTFOUND wiki.corp'));
    expect(error.code).toBe('NETWORK_UNREACHABLE');
    expect(error.action).toBe('retry');
  });

  it('handles a non-Error cause', () => {
    expect(errorFromTransportFailure('something odd').code).toBe('NETWORK_UNREACHABLE');
  });

  it('mentions VPN, the usual on-premise cause', () => {
    expect(errorFromTransportFailure(new Error('ECONNREFUSED')).userMessage).toContain('VPN');
  });
});
