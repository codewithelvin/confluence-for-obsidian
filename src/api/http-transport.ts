import { requestUrl } from 'obsidian';
import { errorFromTransportFailure } from '../util/errors';
import type { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';

/**
 * The HTTP boundary. This is the only module in the plugin permitted to import
 * `requestUrl` (spec §6.1, enforced by ESLint).
 *
 * `requestUrl` is used rather than `fetch` because it bypasses CORS, which the
 * Electron renderer would otherwise enforce against a Confluence origin.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | ArrayBuffer;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  /**
   * The response body as bytes, for an attachment download (spec FR-8.1).
   *
   * Always populated by the real transport — `requestUrl` decodes both forms from
   * the same response — but read only by the download path, which must never
   * route a binary through `text`: a PNG coerced to a string and back is a
   * corrupt PNG.
   */
  readonly bytes: ArrayBuffer;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<Result<HttpResponse, AppError>>;
}

/** Header lookup that tolerates the casing differences proxies introduce. */
export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export class ObsidianTransport implements HttpTransport {
  async send(request: HttpRequest): Promise<Result<HttpResponse, AppError>> {
    try {
      const response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        // Inspect the status rather than letting a 4xx throw, so it can be
        // mapped to a typed error with a user-facing message.
        throw: false,
      });

      return ok({
        status: response.status,
        headers: response.headers,
        text: response.text,
        bytes: response.arrayBuffer,
      });
    } catch (cause) {
      // Reaching here means the request never completed: DNS failure, refused
      // connection, or a TLS chain the OS does not trust.
      return err(errorFromTransportFailure(cause));
    }
  }
}
