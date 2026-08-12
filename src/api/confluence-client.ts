import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';
import { meetsMinimumVersion, type SemanticVersion } from '../util/version';
import {
  parseComment,
  parseCommentRef,
  parsePage,
  parsePageRef,
  parsePaged,
  parseAttachment,
  parseSpace,
  parseUpdatedPage,
  parseUploadedAttachment,
  parseUser,
  type ConfluenceAttachment,
  type ConfluenceComment,
  type ConfluenceCommentRef,
  type ConfluencePage,
  type ConfluencePageRef,
  type ConfluencePageVersion,
  type ConfluenceSpace,
  type ConfluenceUser,
} from './api-types';
import { COMMENT_WINDOW_HOURS, commentsChangedCql, cqlDateTime, subtreeCql } from './cql';
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
 * One page body being written back (spec §6.2.1, FR-5.4).
 *
 * `version` is the number the update is *claiming*, not the one it was read at:
 * Confluence accepts the write only if that is exactly one past the current
 * version, which is what turns a stale push into a 409 instead of a silent
 * overwrite (FR-5.5).
 */
export interface PageUpdate {
  readonly id: string;
  readonly title: string;
  readonly spaceKey: string;
  readonly parentId: string | null;
  readonly version: number;
  readonly storage: string;
}

/**
 * A page being created (spec FR-7.1).
 *
 * No version: Confluence assigns 1. `parentId` is `null` only for a page that
 * belongs at the top of the space, which is why it is stated explicitly rather
 * than omitted — an accidental `undefined` would create the page at the space
 * root, several levels away from where the user asked for it.
 */
export interface PageCreation {
  readonly title: string;
  readonly spaceKey: string;
  readonly parentId: string | null;
  readonly storage: string;
}

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
  uploadAttachment(
    pageId: string,
    filename: string,
    bytes: ArrayBuffer,
  ): Promise<Result<ConfluenceAttachment, AppError>>;
  listComments(pageId: string): Promise<Result<ConfluenceComment[], AppError>>;
  /** Which pages in a space have had a comment change since a moment (§16 O16). */
  listChangedComments(
    spaceKey: string,
    since: string,
  ): Promise<Result<ConfluenceCommentRef[], AppError>>;
  addLabels(pageId: string, labels: readonly string[]): Promise<Result<void, AppError>>;
  removeLabel(pageId: string, label: string): Promise<Result<void, AppError>>;
  updatePage(update: PageUpdate): Promise<Result<ConfluencePageVersion, AppError>>;
  createPage(creation: PageCreation): Promise<Result<ConfluencePageVersion, AppError>>;
  deletePage(pageId: string): Promise<Result<void, AppError>>;
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

  /**
   * Uploads a file the note embeds but the page does not have (spec FR-8.6).
   *
   * A name that already exists on the page becomes a new *version* of that
   * attachment rather than a second file — which is Confluence's behaviour, not a
   * choice made here, and why the push path checks first that the name it is about
   * to use belongs to the file it means.
   */
  async uploadAttachment(
    pageId: string,
    filename: string,
    bytes: ArrayBuffer,
  ): Promise<Result<ConfluenceAttachment, AppError>> {
    return this.runner.upload(
      ENDPOINTS.attachments(pageId),
      filename,
      bytes,
      parseUploadedAttachment,
    );
  }

  /**
   * Every comment on a page, replies included (spec FR-9.3).
   *
   * `depth=all` flattens the reply threads into the collection. Without it the
   * endpoint returns only top-level comments, and a discussion where the answer is
   * a reply would show the question and not the answer.
   */
  async listComments(pageId: string): Promise<Result<ConfluenceComment[], AppError>> {
    return this.runner.collect(
      ENDPOINTS.comments(pageId),
      {
        depth: 'all',
        expand: 'body.storage,history,version,extensions.inlineProperties',
      },
      parseComment,
    );
  }

  /**
   * Pages whose comments moved since `since` — one request per sync (§16 O16).
   *
   * FR-9.4 regenerates the comments region as part of writing a page's body, and a
   * sync fetches a body only where the version moved (FR-3.3). So a colleague who
   * comments without editing changes nothing the sync looks at, and the remark never
   * reaches the mirror. This query is what makes them visible: it names the pages,
   * and the ordinary pull does the rest.
   *
   * No bodies are expanded. `container` is what identifies the page and `version`
   * is what lets the caller discard the extra results the §6.2's date margin brings
   * back; both together are a fraction of one comment's text.
   */
  async listChangedComments(
    spaceKey: string,
    since: string,
    options: CollectOptions = {},
  ): Promise<Result<ConfluenceCommentRef[], AppError>> {
    const from = cqlDateTime(since, COMMENT_WINDOW_HOURS);
    // An index with an unreadable timestamp is not worth failing a sync over; the
    // mirror simply behaves as it did before this query existed.
    if (from === null) return ok([]);

    return this.runner.collect(
      ENDPOINTS.contentSearch,
      { cql: commentsChangedCql(spaceKey, from), expand: 'container,version' },
      parseCommentRef,
      options,
    );
  }

  /**
   * Adds labels to a page (spec FR-9.2).
   *
   * One request for the whole set: the endpoint takes an array, and a request per
   * label would multiply the cost of a batch push by however many tags the user
   * happens to keep.
   */
  async addLabels(pageId: string, labels: readonly string[]): Promise<Result<void, AppError>> {
    if (labels.length === 0) return ok(undefined);

    return this.runner.jsonBody(
      ENDPOINTS.labels(pageId),
      'POST',
      labels.map((name) => ({ prefix: 'global', name })),
      // The response echoes the page's whole label list, which the caller already
      // knows; only the status matters.
      () => ok(undefined),
    );
  }

  /**
   * Removes one label (spec FR-9.2).
   *
   * Singular because the endpoint is: removal takes the name as a query parameter,
   * so a set has to be a request each.
   */
  async removeLabel(pageId: string, label: string): Promise<Result<void, AppError>> {
    return this.runner.empty(ENDPOINTS.labels(pageId), { name: label }, 'DELETE');
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
   * push, blank the page. `metadata.labels` rides along on the same request
   * (FR-9.1) — the labels are needed for every page whose body is fetched, and
   * asking separately would double the request count of a full pull.
   */
  async getPage(id: string): Promise<Result<ConfluencePage, AppError>> {
    return this.runner.json(
      ENDPOINTS.contentById(id),
      { expand: `body.storage,metadata.labels,${REF_EXPANSIONS}` },
      parsePage,
    );
  }

  /**
   * Writes a page body back (spec §6.2.1, FR-5.4).
   *
   * `ancestors` is sent so the update cannot silently reparent the page: a `PUT`
   * that omits it is accepted, and on some Data Center versions moves the page to
   * the top of the space. The title goes with it because Confluence rejects an
   * update that does not carry one.
   */
  async updatePage(update: PageUpdate): Promise<Result<ConfluencePageVersion, AppError>> {
    return this.runner.jsonBody(
      ENDPOINTS.contentById(update.id),
      'PUT',
      {
        id: update.id,
        type: 'page',
        title: update.title,
        space: { key: update.spaceKey },
        ...(update.parentId === null ? {} : { ancestors: [{ id: update.parentId }] }),
        body: { storage: { value: update.storage, representation: 'storage' } },
        version: { number: update.version, message: 'Updated from Obsidian' },
      },
      parseUpdatedPage,
    );
  }

  /**
   * Creates a page (spec FR-7.1).
   *
   * `ancestors` is how a parent is stated on creation; omitting it puts the page at
   * the top of the space, which is never what the user chose. A page with no parent
   * is therefore an explicit decision here, not an accident of an absent field.
   */
  async createPage(creation: PageCreation): Promise<Result<ConfluencePageVersion, AppError>> {
    return this.runner.jsonBody(
      ENDPOINTS.content,
      'POST',
      {
        type: 'page',
        title: creation.title,
        space: { key: creation.spaceKey },
        ...(creation.parentId === null ? {} : { ancestors: [{ id: creation.parentId }] }),
        body: { storage: { value: creation.storage, representation: 'storage' } },
      },
      parseUpdatedPage,
    );
  }

  /**
   * Moves a page to the Confluence trash (spec FR-7.3).
   *
   * A trash, not a purge: `DELETE` on content puts the page in the space's trash,
   * where an administrator can restore it. That is the only reason this operation is
   * offered at all — D6 keeps it out of every automatic path, and FR-7.3 puts a
   * typed confirmation in front of the one command that reaches it.
   */
  async deletePage(pageId: string): Promise<Result<void, AppError>> {
    return this.runner.empty(ENDPOINTS.contentById(pageId), {}, 'DELETE');
  }
}
