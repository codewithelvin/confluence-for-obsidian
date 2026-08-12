/**
 * Logging with mandatory secret redaction.
 *
 * Spec §10 rule 13: a token must never be logged or persisted, in any form,
 * including error messages and debug output. Redaction happens here rather than
 * at call sites, because a call site that forgets is a silent credential leak.
 *
 * Two layers of defence:
 *  1. Pattern redaction catches `Authorization` headers and bearer tokens.
 *  2. Registered-secret redaction catches the live token verbatim, wherever it
 *     surfaces — including inside an exception thrown by a library we do not
 *     control.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACTED = '[REDACTED]';

/** Minimum length before a registered value is treated as a secret. */
const MIN_SECRET_LENGTH = 8;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[\w\-._~+/]+=*/gi,
  /("?[Aa]uthorization"?\s*[:=]\s*"?)[^",\s}]+/g,
  /("?(?:pat|token|password|secret|apiKey)"?\s*[:=]\s*"?)[^",\s}]+/gi,
];

const registeredSecrets = new Set<string>();

/**
 * Registers a live secret for verbatim redaction. Called by the credential
 * store whenever a token enters memory.
 */
export function registerSecret(secret: string): void {
  if (secret.length >= MIN_SECRET_LENGTH) {
    registeredSecrets.add(secret);
  }
}

/** Clears registered secrets. Called when credentials are cleared or on unload. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes anything secret-shaped from a string. Safe to call on any input. */
export function redact(input: string): string {
  let output = input;

  for (const secret of registeredSecrets) {
    output = output.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string | undefined) =>
      prefix === undefined ? REDACTED : `${prefix}${REDACTED}`,
    );
  }

  return output;
}

/** Serialises an arbitrary log argument to a redacted string. */
export function redactValue(value: unknown): string {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) {
    return redact(`${value.name}: ${value.message}`);
  }
  try {
    return redact(JSON.stringify(value) ?? String(value));
  } catch {
    // Circular structures and exotic objects must not break logging.
    return '[unserialisable]';
  }
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly isDebugEnabled: () => boolean,
  ) {}

  /** Creates a child logger for a subsystem, e.g. `sync` -> `sync:pull`. */
  child(subScope: string): Logger {
    return new Logger(`${this.scope}:${subScope}`, this.isDebugEnabled);
  }

  debug(message: string, ...args: readonly unknown[]): void {
    if (!this.isDebugEnabled()) return;
    this.write('debug', message, args);
  }

  info(message: string, ...args: readonly unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: readonly unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: readonly unknown[]): void {
    this.write('error', message, args);
  }

  private write(level: LogLevel, message: string, args: readonly unknown[]): void {
    const prefix = `[confluence-dc:${this.scope}]`;
    const safeMessage = redact(message);
    const safeArgs = args.map(redactValue);

    switch (level) {
      // `console.debug`, not `console.log`: this channel is diagnostic, it is off
      // unless the user turns debug logging on, and a devtools console hides it by
      // default. Obsidian's review asks plugins not to log routinely — `warn` and
      // `error` below stay on the channels a reader is meant to see.
      case 'debug':
      case 'info':
        console.debug(prefix, safeMessage, ...safeArgs);
        break;
      case 'warn':
        console.warn(prefix, safeMessage, ...safeArgs);
        break;
      case 'error':
        console.error(prefix, safeMessage, ...safeArgs);
        break;
    }
  }
}
