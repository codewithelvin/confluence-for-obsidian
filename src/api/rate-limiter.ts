/**
 * Concurrency limiting and retry policy (spec §6.2.2).
 *
 * Data Center rarely rate limits the way Cloud does, but corporate reverse
 * proxies and Confluence's own throttling both return 429/503 under load, so
 * both are handled.
 *
 * The clock and randomness are injected so retry behaviour is deterministic
 * under test — otherwise backoff tests would have to actually wait.
 */

export interface Scheduler {
  sleep(ms: number): Promise<void>;
  /** Uniform in [0, 1). Used for full-jitter backoff. */
  random(): number;
}

export const realScheduler: Scheduler = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30_000,
};

/** Maximum simultaneous in-flight requests (spec §6.2.2). */
export const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Full-jitter exponential backoff. Full jitter (rather than a fixed delay)
 * avoids a thundering herd when many page requests are throttled together.
 */
export function computeBackoffMs(attempt: number, options: RetryOptions, random: number): number {
  const exponential = options.baseDelayMs * Math.pow(options.factor, Math.max(0, attempt - 1));
  return Math.round(Math.min(exponential, options.maxDelayMs) * random);
}

/**
 * Parses a `Retry-After` header. Only the delta-seconds form is honoured; the
 * HTTP-date form is ignored deliberately, because interpreting it would require
 * trusting clock agreement between the client and the server.
 */
export function parseRetryAfterMs(header: string | undefined): number | null {
  if (header === undefined) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/** Statuses worth retrying. 409 is deliberately absent (spec FR-5.5). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

/** Bounds concurrent work; excess callers queue and run as slots free up. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    }
  }

  /** In-flight count. Exposed for assertions and diagnostics. */
  get inFlight(): number {
    return this.active;
  }
}
