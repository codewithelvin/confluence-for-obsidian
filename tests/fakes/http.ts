import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/api/http-transport';
import type { Scheduler } from '../../src/api/rate-limiter';
import { AppError } from '../../src/util/errors';
import { err, ok, type Result } from '../../src/util/result';

/** Test doubles for the HTTP boundary and the injected clock. */

export function textResponse(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, text };
}

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return textResponse(JSON.stringify(body), status, { 'content-type': 'application/json' });
}

export interface RecordingTransport extends HttpTransport {
  readonly requests: HttpRequest[];
}

/**
 * Replays a scripted sequence of responses. An `AppError` entry simulates a
 * transport-level failure (DNS, refused connection, untrusted TLS). Running off
 * the end of the script is a test authoring bug, so it throws loudly.
 */
export function recordingTransport(
  script: readonly (HttpResponse | AppError)[],
): RecordingTransport {
  const requests: HttpRequest[] = [];
  let index = 0;

  return {
    requests,
    send(request: HttpRequest): Promise<Result<HttpResponse, AppError>> {
      requests.push(request);
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`Transport script exhausted after ${String(index - 1)} request(s).`);
      }
      return Promise.resolve(next instanceof AppError ? err(next) : ok(next));
    },
  };
}

/** Always returns the same response, for pagination tests that need many pages. */
export function repeatingTransport(response: HttpResponse): RecordingTransport {
  const requests: HttpRequest[] = [];
  return {
    requests,
    send(request: HttpRequest): Promise<Result<HttpResponse, AppError>> {
      requests.push(request);
      return Promise.resolve(ok(response));
    },
  };
}

export interface TestScheduler extends Scheduler {
  /** Every delay the code under test asked to wait, in order. */
  readonly delays: number[];
}

/** Resolves sleeps immediately and records them, so retry tests do not wait. */
export function testScheduler(randomValue = 1): TestScheduler {
  const delays: number[] = [];
  return {
    delays,
    sleep(ms: number): Promise<void> {
      delays.push(ms);
      return Promise.resolve();
    },
    random(): number {
      return randomValue;
    },
  };
}
