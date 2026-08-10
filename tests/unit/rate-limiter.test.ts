import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY,
  Semaphore,
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../../src/api/rate-limiter';

describe('computeBackoffMs', () => {
  it('grows exponentially with the attempt number', () => {
    const full = 1;
    expect(computeBackoffMs(1, DEFAULT_RETRY, full)).toBe(1000);
    expect(computeBackoffMs(2, DEFAULT_RETRY, full)).toBe(2000);
    expect(computeBackoffMs(3, DEFAULT_RETRY, full)).toBe(4000);
  });

  it('caps at the maximum delay', () => {
    expect(computeBackoffMs(20, DEFAULT_RETRY, 1)).toBe(DEFAULT_RETRY.maxDelayMs);
  });

  it('applies full jitter by scaling with the random value', () => {
    // Full jitter prevents many throttled page requests retrying in lockstep.
    expect(computeBackoffMs(3, DEFAULT_RETRY, 0)).toBe(0);
    expect(computeBackoffMs(3, DEFAULT_RETRY, 0.5)).toBe(2000);
  });

  it('never returns a negative delay', () => {
    expect(computeBackoffMs(0, DEFAULT_RETRY, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(' 30 ')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns null when the header is absent', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });

  it('ignores the HTTP-date form', () => {
    // Honouring a date would mean trusting clock agreement with the server;
    // falling back to computed backoff is safer than acting on a skewed clock.
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
  });

  it('rejects negative and non-numeric values', () => {
    expect(parseRetryAfterMs('-5')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  it.each([429, 502, 503, 504])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it('never auto-retries 409', () => {
    // A version conflict is resolved by the user, not by trying again.
    expect(isRetryableStatus(409)).toBe(false);
  });

  it.each([200, 400, 401, 403, 404, 500])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

describe('Semaphore', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('never runs more tasks at once than the limit', async () => {
    // Asserts the invariant directly rather than depending on how many
    // microtask ticks a slot handover happens to take.
    const semaphore = new Semaphore(2);
    let current = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        semaphore.run(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await Promise.resolve();
          current -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(semaphore.inFlight).toBe(0);
  });

  it('queues work beyond the limit and eventually runs all of it', async () => {
    const semaphore = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );

    // Tasks start synchronously until the limit is reached, so no await is
    // needed here: the third must still be queued.
    expect(started).toEqual([0, 1]);
    expect(semaphore.inFlight).toBe(2);

    for (const gate of gates) gate.resolve();

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    expect(started).toEqual([0, 1, 2]);
  });

  it('releases its slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    expect(semaphore.inFlight).toBe(0);
    await expect(semaphore.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('returns each task result to its own caller', async () => {
    const semaphore = new Semaphore(1);
    const results = await Promise.all([
      semaphore.run(() => Promise.resolve('a')),
      semaphore.run(() => Promise.resolve('b')),
    ]);
    expect(results).toEqual(['a', 'b']);
  });
});
