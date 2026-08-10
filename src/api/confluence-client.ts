import { AppError, errorFromStatus } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import type { Logger } from '../util/logger';
import { meetsMinimumVersion, type SemanticVersion } from '../util/version';
import {
  parseSpace,
  parsePaged,
  parseUser,
  type ConfluenceSpace,
  type ConfluenceUser,
  type Parser,
} from './api-types';
import { ENDPOINTS, buildUrl, type QueryParams } from './endpoints';
import {
  headerValue,
  type HttpMethod,
  type HttpResponse,
  type HttpTransport,
} from './http-transport';
import {
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
  type RetryOptions,
  type Scheduler,
  type Semaphore,
} from './rate-limiter';
import { parseVersionFromBody } from './version-detection';

/** Supplies the current PAT, or `null` when no credential is available. */
export type TokenProvider = () => string | null;

export interface ConnectionCheck {
  readonly user: ConfluenceUser;
  /** `null` when no probe yielded a version — reported, never silently assumed. */
  readonly version: SemanticVersion | null;
  readonly versionSupported: boolean;
}

export interface ConfluenceClientDeps {
  readonly transport: HttpTransport;
  readonly semaphore: Semaphore;
  readonly scheduler: Scheduler;
  readonly retry: RetryOptions;
  readonly logger: Logger;
  readonly pageSize: number;
}

/**
 * The Confluence Data Center gateway. All HTTP to Confluence goes through here
 * (spec §6.1, hard rule) — no other module may talk to the network.
 */
export class ConfluenceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: TokenProvider,
    private readonly deps: ConfluenceClientDeps,
  ) {}

  /** Authenticates and detects the server version (spec FR-1.6, FR-1.7). */
  async checkConnection(): Promise<Result<ConnectionCheck, AppError>> {
    const user = await this.getJson(ENDPOINTS.currentUser, {}, parseUser);
    if (!user.ok) return user;

    const version = await this.detectVersion();
    return ok({
      user: user.value,
      version,
      versionSupported: version === null ? true : meetsMinimumVersion(version),
    });
  }

  /**
   * Probes each version endpoint in order. Returns `null` if none respond
   * usefully — callers must treat unknown as unknown rather than assuming
   * support, since blocking setup on a failed probe would lock out working
   * instances.
   */
  async detectVersion(): Promise<SemanticVersion | null> {
    for (const path of ENDPOINTS.versionProbes) {
      const response = await this.send(path, {});
      if (!response.ok) continue;

      const version = parseVersionFromBody(response.value.text);
      if (version !== null) {
        this.deps.logger.debug(`Detected Confluence ${version.raw} via ${path}`);
        return version;
      }
    }
    this.deps.logger.warn('Could not determine the Confluence version from any known endpoint.');
    return null;
  }

  /** Lists spaces, following pagination to completion (spec FR-2.1). */
  async listSpaces(
    options: { includePersonal?: boolean } = {},
  ): Promise<Result<ConfluenceSpace[], AppError>> {
    const spaces = await this.collectPages(ENDPOINTS.spaces, {}, parseSpace);
    if (!spaces.ok) return spaces;

    return ok(
      options.includePersonal === true
        ? spaces.value
        : spaces.value.filter((space) => space.type !== 'personal'),
    );
  }

  /**
   * Walks a paged collection using explicit `start`/`limit` rather than
   * following `_links.next`. The `next` link is relative to the instance root
   * and already contains any reverse-proxy context path, so appending it to a
   * base URL that also contains that path would duplicate it.
   */
  private async collectPages<T>(
    path: string,
    query: QueryParams,
    parseItem: Parser<T>,
  ): Promise<Result<T[], AppError>> {
    const collected: T[] = [];
    const limit = this.deps.pageSize;
    let start = 0;

    for (;;) {
      const page = await this.getJson(path, { ...query, start, limit }, (raw) =>
        parsePaged(raw, parseItem),
      );
      if (!page.ok) return page;

      collected.push(...page.value.results);
      if (page.value.results.length < limit) return ok(collected);
      start += limit;
    }
  }

  private async getJson<T>(
    path: string,
    query: QueryParams,
    parse: Parser<T>,
  ): Promise<Result<T, AppError>> {
    const response = await this.send(path, query);
    if (!response.ok) return response;

    let body: unknown;
    try {
      body = JSON.parse(response.value.text);
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

  private async send(
    path: string,
    query: QueryParams,
    method: HttpMethod = 'GET',
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
    return this.deps.semaphore.run(() => this.sendWithRetry(url, method, token, path));
  }

  private async sendWithRetry(
    url: string,
    method: HttpMethod,
    token: string,
    context: string,
  ): Promise<Result<HttpResponse, AppError>> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, application/xml;q=0.9, */*;q=0.8',
      'X-Atlassian-Token': 'no-check',
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await this.deps.transport.send({ url, method, headers });

      // A transport failure is DNS, refusal or TLS — retrying cannot help.
      if (!result.ok) return result;

      const response = result.value;
      this.deps.logger.debug(`${method} ${context} -> ${String(response.status)}`);

      if (response.status >= 200 && response.status < 300) return ok(response);

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
