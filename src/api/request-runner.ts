import { AppError, errorFromStatus } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { parsePaged, type Parser } from './api-types';
import { buildUrl, type QueryParams } from './endpoints';
import {
  headerValue,
  type HttpMethod,
  type HttpResponse,
  type HttpTransport,
} from './http-transport';
import { collectAllPages, type CollectOptions } from './pagination';
import {
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
  type RetryOptions,
  type Scheduler,
  type Semaphore,
} from './rate-limiter';

/**
 * HTTP plumbing for the Confluence gateway (spec §6.2.2): authentication,
 * concurrency, retry, JSON decoding and pagination.
 *
 * Split from `ConfluenceClient` so that file stays a readable list of
 * endpoints. Both live in `src/api/`, which is still the only place in the
 * plugin that performs HTTP (spec §6.1).
 */

/** Supplies the current PAT, or `null` when no credential is available. */
export type TokenProvider = () => string | null;

export interface RequestDeps {
  readonly transport: HttpTransport;
  readonly semaphore: Semaphore;
  readonly scheduler: Scheduler;
  readonly retry: RetryOptions;
  readonly logger: Logger;
  readonly pageSize: number;
}

export class RequestRunner {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: TokenProvider,
    private readonly deps: RequestDeps,
  ) {}

  get pageSize(): number {
    return this.deps.pageSize;
  }

  async send(
    path: string,
    query: QueryParams,
    method: HttpMethod = 'GET',
    body?: string,
  ): Promise<Result<HttpResponse, AppError>> {
    const token = this.getToken();
    if (token === null) {
      return err(
        new AppError('CREDENTIALS_UNAVAILABLE', 'No Personal Access Token is available.', {
          action: 'open-settings',
        }),
      );
    }

    const url = buildUrl(this.baseUrl, path, query);
    return this.deps.semaphore.run(() => this.sendWithRetry(url, method, token, path, body));
  }

  async json<T>(path: string, query: QueryParams, parse: Parser<T>): Promise<Result<T, AppError>> {
    const response = await this.send(path, query);
    if (!response.ok) return response;

    return this.decode(response.value, parse);
  }

  /**
   * A request that carries a JSON body — the page update behind push (FR-5.4).
   *
   * Serialised here rather than by the caller so the body and its `Content-Type`
   * are always set together: `requestUrl` sends a body without one happily, and
   * Confluence answers such a request with a 415 that says nothing useful.
   */
  async jsonBody<T>(
    path: string,
    method: HttpMethod,
    payload: unknown,
    parse: Parser<T>,
  ): Promise<Result<T, AppError>> {
    const response = await this.send(path, {}, method, JSON.stringify(payload));
    if (!response.ok) return response;

    return this.decode(response.value, parse);
  }

  private decode<T>(response: HttpResponse, parse: Parser<T>): Result<T, AppError> {
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      return err(
        new AppError(
          'MALFORMED_RESPONSE',
          'Confluence returned a response that was not JSON. If your instance is behind an ' +
            'SSO portal, the plugin may be receiving a login page instead of the API.',
        ),
      );
    }
    return parse(body);
  }

  /** Walks a paged collection to completion (spec §6.2.2). */
  async collect<T>(
    path: string,
    query: QueryParams,
    parseItem: Parser<T>,
    options: CollectOptions = {},
  ): Promise<Result<T[], AppError>> {
    return collectAllPages(
      (start, limit) =>
        this.json(path, { ...query, start, limit }, (raw) => parsePaged(raw, parseItem)),
      this.deps.pageSize,
      options,
    );
  }

  private async sendWithRetry(
    url: string,
    method: HttpMethod,
    token: string,
    context: string,
    body?: string,
  ): Promise<Result<HttpResponse, AppError>> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, application/xml;q=0.9, */*;q=0.8',
      'X-Atlassian-Token': 'no-check',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await this.deps.transport.send({
        url,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });

      // A transport failure is DNS, refusal or TLS — retrying cannot help.
      if (!result.ok) return result;

      const response = result.value;
      this.deps.logger.debug(`${method} ${context} -> ${String(response.status)}`);

      if (response.status >= 200 && response.status < 300) return ok(response);

      // Retrying a bodied request is safe because a page update carries the
      // version it expects (FR-5.4): if the first attempt actually landed, the
      // retry comes back 409 and routes to the conflict flow rather than
      // overwriting anything (FR-5.5).
      const exhausted = attempt >= this.deps.retry.maxAttempts;
      if (exhausted || !isRetryableStatus(response.status)) {
        return err(errorFromStatus(response.status, context));
      }

      const retryAfter = parseRetryAfterMs(headerValue(response.headers, 'retry-after'));
      const backoff = computeBackoffMs(attempt, this.deps.retry, this.deps.scheduler.random());
      await this.deps.scheduler.sleep(retryAfter ?? backoff);
    }
  }
}
