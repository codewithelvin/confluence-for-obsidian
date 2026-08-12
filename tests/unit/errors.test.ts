import { describe, expect, it } from 'vitest';
import {
  AppError,
  bodyOutline,
  errorFromStatus,
  errorFromTransportFailure,
  isAppError,
  serverMessage,
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

describe("Confluence's own explanation (§6.8)", () => {
  it('carries the server message into a 403, which is the only place the reason lives', () => {
    // A 403 on `POST /rest/api/content` is indistinguishable from any other 403
    // without it: no space permission, a restricted parent page and a failed XSRF
    // check all look the same.
    const body = JSON.stringify({
      statusCode: 403,
      message: 'No permission to create content in space TT',
    });

    const error = errorFromStatus(403, '/rest/api/content', serverMessage(body) ?? undefined);

    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.userMessage).toContain('No permission to create content in space TT');
  });

  it('reads a message out of a Confluence error body', () => {
    expect(serverMessage('{"message":"  A page with this title already exists  "}')).toBe(
      'A page with this title already exists',
    );
  });

  it('ignores anything that is not a short JSON message', () => {
    // An instance behind an SSO portal answers with an HTML login page, and a
    // proxy can answer with anything at all.
    expect(serverMessage('<html><body>Login</body></html>')).toBeNull();
    expect(serverMessage('{"statusCode":403}')).toBeNull();
    expect(serverMessage('{"message":""}')).toBeNull();
    expect(serverMessage('')).toBeNull();
    expect(serverMessage(`{"message":"${'x'.repeat(9000)}"}`)).toBeNull();
  });

  it('truncates a message long enough to fill the notice', () => {
    const long = serverMessage(`{"message":"${'y'.repeat(400)}"}`);
    expect(long?.length).toBe(301);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('says nothing extra when Confluence sent no explanation', () => {
    expect(errorFromStatus(403, '/rest/api/content').userMessage).not.toContain('Confluence said');
  });
});

describe('outlining a refusal that carried no JSON message', () => {
  // Confluence's REST layer always states its reason in JSON. A refusal without one
  // came from somewhere earlier — a servlet filter, a proxy, a WAF — and that is a
  // different problem with a different remedy, so the log has to be able to say so.

  it('names an empty body and its content type', () => {
    expect(bodyOutline('', 'text/html;charset=UTF-8')).toBe('empty text/html body');
    expect(bodyOutline('   \n  ', undefined)).toBe('empty untyped body');
  });

  it('reports the wire length, which separates a silent server from a lost body', () => {
    // An empty `text` beside a non-zero byte count is the transport dropping the body,
    // not a refusal that arrived without one — and the two have opposite remedies.
    expect(bodyOutline('', 'application/json', 412)).toBe(
      'empty application/json body, 412 bytes on the wire',
    );
    expect(bodyOutline('', 'application/json', 0)).toBe(
      'empty application/json body, 0 bytes on the wire',
    );
  });

  it('shows the start of an HTML error page, collapsed to one line', () => {
    const page = '<html>\n  <body>\n    XSRF check failed\n  </body>\n</html>';

    const outline = bodyOutline(page, 'text/html');

    expect(outline).toContain('text/html');
    expect(outline).toContain('XSRF check failed');
    expect(outline).not.toContain('\n');
  });

  it('reports the true length even when the shown text is truncated', () => {
    const outline = bodyOutline('z'.repeat(500), 'application/json');

    expect(outline).toContain('500-char');
    expect(outline.endsWith('…')).toBe(true);
  });

  it('drops the charset, which is never the interesting part', () => {
    expect(bodyOutline('nope', 'application/json;charset=UTF-8')).toContain('application/json ');
  });
});
