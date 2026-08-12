import { AppError, bodyOutline, errorFromStatus, serverMessage } from '../util/errors';
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

/**
 * A request body and the `Content-Type` that describes it.
 *
 * The two travel together because they are never independently correct: a JSON
 * body sent as `multipart/form-data`, or multipart bytes sent as JSON, is a 400
 * whose message says nothing about which half was wrong.
 */
export interface RequestBody {
  readonly content: string | ArrayBuffer;
  readonly contentType: string;
}

/**
 * A file name that would break the part header.
 *
 * A quote or a line break inside `Content-Disposition` lets the name terminate the
 * header and inject one of its own, so such a name is refused rather than escaped:
 * Confluence attachment names do not legitimately contain either, and guessing at
 * an encoding the server may not share would upload the file under a name no
 * embed then matches.
 */
const UNSAFE_FILENAME = /["\r\n]/;

/**
 * Assembles a `multipart/form-data` body holding one file (spec FR-8.6).
 *
 * `minorEdit` is sent so uploading an image does not put a notification in every
 * watcher's inbox — the user is publishing a page, not announcing a picture.
 */
export function multipartBody(
  filename: string,
  bytes: ArrayBuffer,
  boundary: string,
): Result<RequestBody, AppError> {
  if (filename.length === 0 || UNSAFE_FILENAME.test(filename)) {
    return err(
      new AppError(
        'VAULT_WRITE_FAILED',
        `"${filename}" cannot be uploaded to Confluence: an attachment name may not contain ` +
          'a quotation mark or a line break.',
      ),
    );
  }

  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = encoder.encode(
    `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="minorEdit"\r\n\r\n' +
      `true\r\n--${boundary}--\r\n`,
  );

  const file = new Uint8Array(bytes);
  const content = new Uint8Array(head.length + file.length + tail.length);
  content.set(head, 0);
  content.set(file, head.length);
  content.set(tail, head.length + file.length);

  return ok({
    content: content.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

/**
 * Identifies the plugin — and, more importantly, does not look like a browser.
 *
 * Left unset, Electron sends Obsidian's own `Mozilla/5.0 … Chrome/… Safari/…`, and
 * Confluence reads that `Mozilla` prefix as "a browser is calling". Its XSRF filter then
 * challenges the request and answers `XSRF check failed` as plain HTML *before*
 * authentication or permissions are reached — and `X-Atlassian-Token: no-check` does not
 * exempt it, which is what makes the failure so hard to read: it presents as a permission
 * problem on a request that was never authenticated in the first place.
 *
 * Measured on 7.19.6 (2026-08-12) by replaying the captured Electron request: POSTs
 * differing *only* in this header get the XSRF page with the browser agent and
 * Confluence's own JSON answer without it. It cost `POST /rest/api/content` entirely —
 * `PUT` and `DELETE` were unaffected, because the filter only guards `POST`, which is
 * why update, reparent and delete all worked while creating a page never did.
 *
 * No version string: it would drift against `manifest.json` and nothing reads it.
 */
const USER_AGENT = 'confluence-dc-connector (Obsidian plugin)';

/**
 * Why a request was refused — parsed once, for both readers of that answer.
 *
 * Confluence's REST layer states its reason in a JSON `message`, and that reason is the
 * only thing separating a rejected token, an instance that answers anonymous instead of
 * 401, and a genuine space right: without it all three are a bare 403. A refusal
 * carrying no such message did not come from that layer at all — an empty body or an
 * HTML page means a servlet filter, a proxy or a WAF answered first — so the outline
 * describes the body instead. That is the difference between "Confluence refused this"
 * and "something in front of Confluence did", and the two have different remedies.
 *
 * `detail` feeds the typed error and `outline` feeds the log, from one parse, so the
 * notice and the console can never disagree about what happened.
 */
function refusalReason(response: HttpResponse): {
  readonly detail: string | null;
  readonly outline: string;
} {
  const detail = serverMessage(response.text);
  return {
    detail,
    outline:
      detail ??
      bodyOutline(
        response.text,
        headerValue(response.headers, 'content-type'),
        response.bytes.byteLength,
      ),
  };
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
    body?: RequestBody,
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
    const response = await this.send(path, {}, method, {
      content: JSON.stringify(payload),
      contentType: 'application/json',
    });
    if (!response.ok) return response;

    return this.decode(response.value, parse);
  }

  /**
   * A request with no response body worth reading — a label removal (FR-9.2).
   *
   * Confluence answers `DELETE .../label` with 204 and an empty body, so decoding
   * it as JSON would fail on a request that succeeded.
   */
  async empty(
    path: string,
    query: QueryParams,
    method: HttpMethod,
  ): Promise<Result<void, AppError>> {
    const response = await this.send(path, query, method);
    return response.ok ? ok(undefined) : response;
  }

  /**
   * Uploads one file as `multipart/form-data` (spec FR-8.6).
   *
   * The body is assembled by hand as bytes. `FormData` cannot be used: it is only
   * meaningful to `fetch`, and §6.1 requires every request to go through
   * `requestUrl`, which takes a string or an `ArrayBuffer`. Encoding the file part
   * as a string is not an option either — a PNG that has been through a JavaScript
   * string is a corrupt PNG.
   */
  async upload<T>(
    path: string,
    filename: string,
    bytes: ArrayBuffer,
    parse: Parser<T>,
  ): Promise<Result<T, AppError>> {
    const body = multipartBody(filename, bytes, this.boundary());
    if (!body.ok) return body;

    const response = await this.send(path, {}, 'POST', body.value);
    if (!response.ok) return response;

    return this.decode(response.value, parse);
  }

  /**
   * A part boundary that will not occur in the payload.
   *
   * Drawn from the injected scheduler rather than `Math.random` so a test sees a
   * fixed boundary and can assert on the assembled body (§7.5).
   */
  private boundary(): string {
    const noise = Math.floor(this.deps.scheduler.random() * 0xffffffff).toString(16);
    return `----confluence-dc-connector-${noise.padStart(8, '0')}`;
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
    body?: RequestBody,
  ): Promise<Result<HttpResponse, AppError>> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, application/xml;q=0.9, */*;q=0.8',
      'X-Atlassian-Token': 'no-check',
      'User-Agent': USER_AGENT,
      ...(body === undefined ? {} : { 'Content-Type': body.contentType }),
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await this.deps.transport.send({
        url,
        method,
        headers,
        ...(body === undefined ? {} : { body: body.content }),
      });

      // A transport failure is DNS, refusal or TLS — retrying cannot help.
      if (!result.ok) return result;

      const response = result.value;
      this.deps.logger.debug(`${method} ${context} -> ${String(response.status)}`);

      if (response.status >= 200 && response.status < 300) return ok(response);

      // `warn`, not `debug`, so a refusal explains itself without debug logging having
      // been switched on first. The logger redacts before anything reaches the console.
      const refusal = refusalReason(response);
      this.deps.logger.warn(
        `${method} ${context} -> ${String(response.status)} — ${refusal.outline}`,
      );

      // Retrying a bodied request is safe because a page update carries the
      // version it expects (FR-5.4): if the first attempt actually landed, the
      // retry comes back 409 and routes to the conflict flow rather than
      // overwriting anything (FR-5.5). An attachment upload carries no version,
      // and `POST child/attachment` does *not* turn a repeated name into a new
      // version — it answers 400 (measured on 7.19.6, 2026-08-12). That is
      // survivable rather than dangerous, because only an HTTP *response* is
      // retried: reaching here means Confluence answered 429 or 5xx and did not
      // store the file, while a lost response is a transport failure and returns
      // above without one. 400 is not retryable, so a genuine duplicate fails
      // loudly instead of looping.
      const exhausted = attempt >= this.deps.retry.maxAttempts;
      if (exhausted || !isRetryableStatus(response.status)) {
        return err(
          refusal.detail === null
            ? errorFromStatus(response.status, context)
            : errorFromStatus(response.status, context, refusal.detail),
        );
      }

      const retryAfter = parseRetryAfterMs(headerValue(response.headers, 'retry-after'));
      const backoff = computeBackoffMs(attempt, this.deps.retry, this.deps.scheduler.random());
      await this.deps.scheduler.sleep(retryAfter ?? backoff);
    }
  }
}
