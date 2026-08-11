import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';
import { meetsMinimumVersion, type SemanticVersion } from '../util/version';
import {
  parsePage,
  parsePageRef,
  parsePaged,
  parseAttachment,
  parseSpace,
  parseUser,
  type ConfluenceAttachment,
  type ConfluencePage,
  type ConfluencePageRef,
  type ConfluenceSpace,
  type ConfluenceUser,
} from './api-types';
import { subtreeCql } from './cql';
import { ENDPOINTS } from './endpoints';
import type { CollectOptions } from './pagination';
import { RequestRunner, type RequestDeps, type TokenProvider } from './request-runner';
import { parseVersionFromBody } from './version-detection';

/**
 * The Confluence Data Center gateway. All HTTP to Confluence goes through here
 * (spec §6.1, hard rule) — no other module may talk to the network.
 *
 * HTTP mechanics live in `RequestRunner`; this file is the list of endpoints the
 * plugin uses and the shapes they return.
 */

export type { TokenProvider };

export interface ConnectionCheck {
  readonly user: ConfluenceUser;
  /** `null` when no probe yielded a version — reported, never silently assumed. */
  readonly version: SemanticVersion | null;
  readonly versionSupported: boolean;
}

export type ConfluenceClientDeps = RequestDeps;

/**
 * The narrow view of the gateway that sync depends on (spec §6.1).
 *
 * Declared as an interface so the sync engine can be exercised end to end
 * against a fake with no network at all — the concrete client is only needed
 * where real HTTP is.
 */
export interface ConfluenceGateway {
  checkConnection(): Promise<Result<ConnectionCheck, AppError>>;
  spaceHomepageId(spaceKey: string): Promise<Result<string | null, AppError>>;
  listSubtree(
    spaceKey: string,
    rootPageId: string | null,
    options?: CollectOptions,
  ): Promise<Result<ConfluencePageRef[], AppError>>;
  countSubtree(
    spaceKey: string,
    rootPageId: string | null,
  ): Promise<Result<number | null, AppError>>;
  getPage(id: string): Promise<Result<ConfluencePage, AppError>>;
  listAttachments(pageId: string): Promise<Result<ConfluenceAttachment[], AppError>>;
  downloadAttachment(downloadPath: string): Promise<Result<ArrayBuffer, AppError>>;
}

/**
 * Expansions needed to place a page in the tree and tell whether it changed,
 * without transferring any bodies.
 */
const REF_EXPANSIONS = 'version,ancestors,space';

export class ConfluenceClient implements ConfluenceGateway {
  private readonly runner: RequestRunner;

  constructor(baseUrl: string, getToken: TokenProvider, deps: ConfluenceClientDeps) {
    this.runner = new RequestRunner(baseUrl, getToken, deps);
  }

  /** Authenticates and detects the server version (spec FR-1.6, FR-1.7). */
  async checkConnection(): Promise<Result<ConnectionCheck, AppError>> {
    const user = await this.runner.json(ENDPOINTS.currentUser, {}, parseUser);
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
      const response = await this.runner.send(path, {});
      if (!response.ok) continue;

      const version = parseVersionFromBody(response.value.text);
      if (version !== null) return version;
    }
    return null;
  }

  /**
   * The space's home page id, which becomes the mount's folder note (D13).
   *
   * `null` means the space genuinely has no home page — a stable property of the
   * space, so the layout it produces is stable too. A *failed* request is an
   * error rather than a `null`: silently treating it as "no home page" would
   * shift every path in the mount up one level and turn a transient network
   * blip into a mass file move.
   */
  async spaceHomepageId(spaceKey: string): Promise<Result<string | null, AppError>> {
    const space = await this.runner.json(
      ENDPOINTS.spaceByKey(spaceKey),
      { expand: 'homepage' },
      parseSpace,
    );
    return space.ok ? ok(space.value.homepageId) : space;
  }

  /**
   * Every attachment on a page (spec FR-8.1).
   *
   * `version` decides whether the bytes need fetching again (FR-8.3) and
   * `extensions` carries the file size the limit is judged against (FR-8.4), so
   * both are expanded — the endpoint reports neither by default.
   */
  async listAttachments(pageId: string): Promise<Result<ConfluenceAttachment[], AppError>> {
    return this.runner.collect(
      ENDPOINTS.attachments(pageId),
      { expand: 'version,extensions' },
      parseAttachment,
    );
  }

  /**
   * An attachment's bytes.
   *
   * The path comes from the listing's own `_links.download`, which already
   * carries the version query — assembling it here would be guessing at a form
   * Confluence has already told us.
   */
  async downloadAttachment(downloadPath: string): Promise<Result<ArrayBuffer, AppError>> {
    const response = await this.runner.send(downloadPath, {});
    return response.ok ? ok(response.value.bytes) : response;
  }

  /** Lists spaces, following pagination to completion (spec FR-2.1). */
  async listSpaces(
    options: { includePersonal?: boolean } = {},
  ): Promise<Result<ConfluenceSpace[], AppError>> {
    const spaces = await this.runner.collect(ENDPOINTS.spaces, {}, parseSpace);
    if (!spaces.ok) return spaces;

    return ok(
      options.includePersonal === true
        ? spaces.value
        : spaces.value.filter((space) => space.type !== 'personal'),
    );
  }

  /** Lists pages in a space, newest first, up to `limit`. */
  async listPages(spaceKey: string, limit: number): Promise<Result<ConfluencePageRef[], AppError>> {
    const page = await this.runner.json(
      ENDPOINTS.content,
      { spaceKey, type: 'page', limit, start: 0 },
      (raw) => parsePaged(raw, parsePageRef),
    );
    if (!page.ok) return page;
    return ok([...page.value.results]);
  }

  /**
   * Every page in a subscription's scope, with version and parent but no body
   * (spec §6.6.2 step 2).
   *
   * The whole tree is enumerated on every sync, not just what changed since the
   * last one: a page that was deleted or moved out of the subtree produces no
   * result at all in a `lastModified` query, so an incremental-only walk cannot
   * satisfy FR-3.5 or FR-3.6. Versions come back with the enumeration, so the
   * expensive part — fetching bodies — is still limited to what actually
   * changed.
   */
  async listSubtree(
    spaceKey: string,
    rootPageId: string | null,
    options: CollectOptions = {},
  ): Promise<Result<ConfluencePageRef[], AppError>> {
    if (rootPageId === null) {
      return this.runner.collect(
        ENDPOINTS.content,
        { spaceKey, type: 'page', expand: REF_EXPANSIONS },
        parsePageRef,
        options,
      );
    }

    return this.runner.collect(
      ENDPOINTS.contentSearch,
      { cql: subtreeCql(spaceKey, rootPageId), expand: REF_EXPANSIONS },
      parsePageRef,
      options,
    );
  }

  /**
   * How many pages a subscription would cover (spec FR-2.4).
   *
   * `null` when the server does not report a total, which is why the warning
   * treats unknown as unknown rather than as zero.
   */
  async countSubtree(
    spaceKey: string,
    rootPageId: string | null,
  ): Promise<Result<number | null, AppError>> {
    const page = await this.runner.json(
      ENDPOINTS.contentSearch,
      { cql: subtreeCql(spaceKey, rootPageId), limit: 1, start: 0 },
      (raw) => parsePaged(raw, parsePageRef),
    );
    if (!page.ok) return page;
    return ok(page.value.totalSize);
  }

  /**
   * Fetches one page including its storage body.
   *
   * `body.storage` is requested explicitly: without it Confluence returns a
   * page with no body, which would convert to an empty note and, on a later
   * push, blank the page.
   */
  async getPage(id: string): Promise<Result<ConfluencePage, AppError>> {
    return this.runner.json(
      ENDPOINTS.contentById(id),
      { expand: `body.storage,${REF_EXPANSIONS}` },
      parsePage,
    );
  }
}
