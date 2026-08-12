/**
 * Typed error model (spec §6.8).
 *
 * Every failure carries a stable code and a user-facing message. Raw HTTP
 * statuses are never surfaced to the user, and errors are never thrown as
 * strings.
 */

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'VERSION_UNSUPPORTED'
  | 'NETWORK_UNREACHABLE'
  | 'TLS_UNTRUSTED'
  | 'CONFLICT'
  | 'FIDELITY_DEGRADED'
  | 'VERIFICATION_FAILED'
  | 'FRAGMENT_MISSING'
  | 'OUT_OF_MOUNT'
  | 'PATH_TOO_LONG'
  // Not in the §6.8 table, which lists the codes the *user* can act on. A vault
  // write failing (permissions, a file locked by another tool, a full disk) is
  // real and must be reported per page rather than collapsed into UNKNOWN, so
  // the sync report can name the file that failed.
  | 'VAULT_WRITE_FAILED'
  // Also outside the §6.8 table, and deliberately not something a push fails on:
  // FR-9.2 requires a tag Confluence cannot hold as a label to be *reported* rather
  // than dropped, and reporting it needs a code to report it under.
  | 'LABEL_UNSUPPORTED'
  // An embed the push cannot carry to Confluence as written (FR-8.6). Its own code
  // because the remedy is specific and the user can apply it: write the embed as the
  // full vault path.
  | 'EMBED_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'MALFORMED_RESPONSE'
  | 'INVALID_BASE_URL'
  | 'CREDENTIALS_UNAVAILABLE'
  // Cancellation is deliberately *not* a code. A sync the user stopped still did
  // most of what it set out to do, and reporting that work as a failure would hide
  // it; it is a flag on the report (`SyncReport.cancelled`) instead.
  | 'UNKNOWN';

/** A remedy the UI can offer alongside an error. */
export type ErrorAction =
  | 'open-settings'
  | 'retry'
  | 'open-docs'
  | 'open-in-confluence'
  | 'show-diff'
  | 'repull-page'
  | 'none';

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Safe to show verbatim in the UI. */
  readonly userMessage: string;
  readonly action: ErrorAction;
  readonly status: number | undefined;

  constructor(
    code: ErrorCode,
    userMessage: string,
    options: {
      readonly action?: ErrorAction;
      readonly status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(userMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.action = options.action ?? 'none';
    this.status = options.status;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * The explanation Confluence sent with a refusal.
 *
 * Its own `message` field says *why* — "No permission to create content in space TT",
 * "XSRF check failed", "A page with this title already exists" — and without it a 403
 * is indistinguishable from any other 403. That cost a live debugging round on the
 * first attempt to create a page, so the server's own words are now carried through.
 *
 * Read defensively and truncated: this is a response body from an instance that may
 * be behind a proxy returning HTML, so anything that is not a short JSON `message` is
 * discarded rather than shown.
 */
export function serverMessage(body: string): string | null {
  if (body.length === 0 || body.length > 8192) return null;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'string' || message.trim().length === 0) return null;

    const trimmed = message.trim();
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  } catch {
    return null;
  }
}

/**
 * A short, safe description of a refusal that carried no JSON `message`.
 *
 * Confluence's REST layer always states its reason in a JSON body. A refusal without
 * one therefore did not come from that layer: an empty body or an HTML error page
 * means a servlet filter, a reverse proxy or a WAF answered first, and that is a
 * different problem from a permission with a different remedy. Naming which is worth
 * far more than logging a bare status — a 403 alone is indistinguishable between a
 * rejected token, an XSRF filter and a genuine space right.
 *
 * Collapsed and truncated because the body may be a full HTML page.
 */
export function bodyOutline(
  body: string,
  contentType: string | undefined,
  byteLength?: number,
): string {
  const type = contentType === undefined ? 'untyped' : contentType.split(';')[0];
  // The wire length separates "the server sent nothing" from "we failed to decode what
  // it sent": an empty `text` beside a non-zero byte count is our transport losing the
  // body, not a refusal that came without one. Those have opposite remedies.
  const wire = byteLength === undefined ? '' : `, ${String(byteLength)} bytes on the wire`;
  if (body.trim().length === 0) return `empty ${type} body${wire}`;

  const collapsed = body.replace(/\s+/g, ' ').trim();
  const shown = collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
  return `${String(body.length)}-char ${type} body: ${shown}`;
}

/** Appends Confluence's own explanation, when it sent one. */
function because(detail: string | undefined): string {
  return detail === undefined || detail.length === 0 ? '' : ` Confluence said: ${detail}`;
}

/**
 * Maps an HTTP status to a typed error. `409` is deliberately mapped to
 * CONFLICT rather than a retryable failure (spec FR-5.5).
 */
export function errorFromStatus(status: number, context: string, detail?: string): AppError {
  switch (status) {
    case 401:
      return new AppError(
        'AUTH_FAILED',
        `Authentication failed — check your Personal Access Token.${because(detail)}`,
        { action: 'open-settings', status },
      );
    case 403:
      return new AppError(
        'PERMISSION_DENIED',
        `Your Confluence account does not have permission for this action (${context}).` +
          `${because(detail)}`,
        { status },
      );
    case 404:
      return new AppError('NOT_FOUND', `Not found in Confluence (${context}).${because(detail)}`, {
        status,
      });
    case 409:
      return new AppError(
        'CONFLICT',
        'This page was changed in Confluence since it was last synced.',
        {
          status,
        },
      );
    case 429:
      return new AppError(
        'RATE_LIMITED',
        'Confluence is rate limiting requests. Try again shortly.',
        {
          action: 'retry',
          status,
        },
      );
    default:
      return unmappedStatus(status, detail);
  }
}

/** Anything with no remedy of its own: a server fault is worth retrying, the rest is not. */
function unmappedStatus(status: number, detail: string | undefined): AppError {
  if (status >= 500) {
    return new AppError(
      'UNKNOWN',
      `Confluence returned a server error (${String(status)}).${because(detail)}`,
      { action: 'retry', status },
    );
  }
  return new AppError(
    'UNKNOWN',
    `Unexpected response from Confluence (${String(status)}).${because(detail)}`,
    { status },
  );
}

/**
 * Classifies a transport-level failure. TLS problems are separated from general
 * connectivity because the remedy is completely different, and a private CA is
 * the most likely first-run failure on an on-premise instance (spec §6.2.3).
 */
export function errorFromTransportFailure(cause: unknown): AppError {
  const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

  if (/certificate|self.signed|CERT_|SSL|TLS|unable to verify/i.test(text)) {
    return new AppError(
      'TLS_UNTRUSTED',
      'The TLS certificate could not be verified. If your Confluence uses a private ' +
        'certificate authority, install its root certificate in your operating system trust store.',
      { action: 'open-docs', cause },
    );
  }

  return new AppError(
    'NETWORK_UNREACHABLE',
    'Could not reach Confluence. Check the base URL, your network, and any VPN requirement.',
    { action: 'retry', cause },
  );
}
