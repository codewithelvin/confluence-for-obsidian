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
  | 'CANCELLED'
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
 * Maps an HTTP status to a typed error. `409` is deliberately mapped to
 * CONFLICT rather than a retryable failure (spec FR-5.5).
 */
export function errorFromStatus(status: number, context: string): AppError {
  switch (status) {
    case 401:
      return new AppError(
        'AUTH_FAILED',
        'Authentication failed — check your Personal Access Token.',
        { action: 'open-settings', status },
      );
    case 403:
      return new AppError(
        'PERMISSION_DENIED',
        `Your Confluence account does not have permission for this action (${context}).`,
        { status },
      );
    case 404:
      return new AppError('NOT_FOUND', `Not found in Confluence (${context}).`, { status });
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
      break;
  }

  if (status >= 500) {
    return new AppError('UNKNOWN', `Confluence returned a server error (${String(status)}).`, {
      action: 'retry',
      status,
    });
  }
  return new AppError('UNKNOWN', `Unexpected response from Confluence (${String(status)}).`, {
    status,
  });
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
