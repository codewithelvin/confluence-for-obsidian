import type { ConfluenceGateway } from '../api/confluence-client';
import { markdownToStorage } from '../convert/markdown-to-storage';
import { verify } from '../convert/round-trip-verifier';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { splitFrontmatter } from '../vault/frontmatter';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import { conversionOptionsFor } from './conversion-options';
import {
  applyDemotions,
  planDemotions,
  type DemotionOp,
  type TidyDeps,
  type TidyOutcome,
  type TidyPlan,
} from './demotion';
import type { FragmentStore } from './fragment-store';
import { LinkIndex, mirroredPages } from './link-index';
import { singlePageExecutor } from './single-page-deps';
import { locateNote, subscriptionFor, type LocatorDeps } from './note-locator';
import { pullSinglePage } from './pull-executor';
import { parentOfPath, placeFor, resolveParent, type PlacementDeps } from './page-placement';
import type { PageState, SyncStateStore } from './sync-state';
import type { BackupStore } from './backup-store';

/**
 * Creating, promoting and deleting single pages (spec FR-7.1 to FR-7.4, US-7, US-8).
 *
 * Everything here is reached only from a command the user ran, never from a sync.
 * That is D6 and FR-5.1 in force: a sync reads, reports and — with FR-7.8's
 * confirmation — rearranges, but it does not bring pages into existence or take them
 * out of it. Each operation is one deliberate act on one page.
 */

export interface PageStructureDeps extends LocatorDeps {
  readonly settings: SettingsStore;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly state: SyncStateStore;
  readonly backups: BackupStore;
  readonly logger: Logger;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceGateway;
  readonly now: () => string;
}

/** Where a new page goes, as the user chose it. */
export interface NewPage {
  readonly subscription: Subscription;
  readonly title: string;
  /**
   * The page it belongs under, or `null` for the top of the mount.
   *
   * `null` means the subscription's root page for a mirror that has one (D13), and
   * the top of the space for one that does not — resolved here rather than by the
   * caller, which has no reason to know about D13.
   */
  readonly parentId: string | null;
}

/** A page that can be a parent, for the picker (FR-7.1). */
export interface ParentChoice {
  readonly pageId: string | null;
  readonly title: string;
  readonly path: string;
}

export class PageStructureService {
  constructor(private readonly deps: PageStructureDeps) {}

  /**
   * The pages a new page could go under, mount first.
   *
   * Read from the index rather than from Confluence: the picker must offer only
   * pages that are actually mirrored, because a page created under an unmirrored
   * parent would have no place in the vault to be written to.
   */
  parentChoices(subscription: Subscription): readonly ParentChoice[] {
    const pages = Object.values(this.deps.state.forSubscription(subscription.id).pages);

    const choices = pages
      .map((page) => ({ pageId: page.pageId, title: page.title, path: page.localPath }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    return [
      {
        pageId: null,
        title: `${subscription.mountPath} (top level)`,
        path: subscription.mountPath,
      },
      ...choices,
    ];
  }

  /**
   * Creates a page and writes its note (spec FR-7.1).
   *
   * The body is created empty and the note is then written by the ordinary pull path,
   * so a page created here is indistinguishable from one that was always there — same
   * frontmatter, same fragment sidecar, same index record. Writing the note by hand
   * would be a second implementation of the one thing this plugin must never get
   * wrong twice.
   */
  async createPage(request: NewPage): Promise<Result<PageState, AppError>> {
    const connection = this.connectionFor(request.subscription);
    if (!connection.ok) return connection;

    const client = this.deps.createClient(connection.value);
    const parentId = await resolveParent(
      this.placement(),
      request.subscription,
      request.parentId,
      client,
    );
    if (!parentId.ok) return parentId;

    const created = await client.createPage({
      title: request.title,
      spaceKey: request.subscription.spaceKey,
      parentId: parentId.value,
      storage: '',
    });
    if (!created.ok) return created;

    const path = placeFor(this.deps.state, request.subscription, request.title, parentId.value);
    if (!path.ok) return path;

    this.deps.logger.debug(`Created page ${created.value.id} at ${path.value}.`);
    return this.writeCreated(request.subscription, connection.value, client, created.value.id, {
      path: path.value,
      isFolderNote: false,
      alias: null,
      labels: [],
    });
  }

  /**
   * Publishes a note the user wrote themselves (spec FR-7.2).
   *
   * The round-trip gate runs *before* the page exists: a note whose Markdown cannot
   * be represented in storage format would otherwise become a page that is read-only
   * from the moment it is created, which is a worse outcome than being told no.
   */
  async promoteNote(notePath: string): Promise<Result<PageState, AppError>> {
    const subscription = subscriptionFor(this.deps.settings.get().subscriptions, notePath);
    if (subscription === null) {
      return err(
        new AppError('OUT_OF_MOUNT', 'This note is not inside a Confluence subscription.'),
      );
    }
    if (this.deps.vault.readIdentity(notePath) !== null) {
      return err(
        new AppError('UNKNOWN', 'This note is already a Confluence page. Push it instead.', {
          action: 'retry',
        }),
      );
    }

    const connection = this.connectionFor(subscription);
    if (!connection.ok) return connection;

    const content = await this.deps.vault.read(notePath);
    if (!content.ok) return content;

    const body = splitFrontmatter(content.value).body;
    const title = titleOf(notePath);
    const storage = this.representable(subscription, connection.value, body);
    if (!storage.ok) return storage;

    const client = this.deps.createClient(connection.value);
    const parentId = parentOfPath(this.deps.state, subscription, notePath);
    if (!parentId.ok) return parentId;

    const created = await client.createPage({
      title,
      spaceKey: subscription.spaceKey,
      parentId: parentId.value,
      storage: storage.value,
    });
    if (!created.ok) return created;

    // Pulled straight back rather than left as it is: the note now has to carry the
    // identity, the alias and the fragment sidecar every tracked note carries, and
    // the pull path is the one place that knows how to produce all three.
    return this.writeCreated(subscription, connection.value, client, created.value.id, {
      path: notePath,
      isFolderNote: false,
      alias: null,
      labels: [],
    });
  }

  /**
   * Trashes a page and removes its note (spec FR-7.3).
   *
   * The remote call goes first. A local file removed beside a page that is still
   * there is an orphan the user can restore in one click (FR-7.4); a page trashed
   * beside a note that is still here would be a mirror claiming to track something
   * that no longer exists.
   */
  async deletePage(notePath: string): Promise<Result<void, AppError>> {
    const located = locateNote(this.deps, notePath);
    if (!located.ok) return located;

    const { subscription, connection, pageId } = located.value;
    const deleted = await this.deps.createClient(connection).deletePage(pageId);
    if (!deleted.ok) return deleted;

    const trashed = await this.deps.vault.trash(notePath);
    if (!trashed.ok) return trashed;

    await this.deps.vault.removeEmptyFolder(parentPath(notePath));
    await this.deps.fragments.remove(pageId);
    await this.forget(subscription.id, pageId);

    this.deps.logger.debug(`Deleted page ${pageId} and its note at ${notePath}.`);
    return ok(undefined);
  }

  /**
   * Deletes the page behind an orphaned record (FR-7.4).
   *
   * The note is already gone, so there is nothing local to remove — only the page and
   * the index entry that still points at it.
   */
  async deleteOrphan(subscription: Subscription, pageId: string): Promise<Result<void, AppError>> {
    const connection = this.connectionFor(subscription);
    if (!connection.ok) return connection;

    const deleted = await this.deps.createClient(connection.value).deletePage(pageId);
    if (!deleted.ok) return deleted;

    await this.deps.fragments.remove(pageId);
    await this.forget(subscription.id, pageId);
    return ok(undefined);
  }

  /**
   * The folder notes in a subscription that no longer need their folders (§6.5.4).
   *
   * Planning and applying are separate calls because FR-7.8's preview sits between
   * them: the user sees the whole list, and nothing moves until they say so.
   */
  planTidy(subscription: Subscription): TidyPlan {
    return planDemotions(this.tidy(), subscription);
  }

  /** Carries out the demotions the user confirmed. */
  applyTidy(subscription: Subscription, ops: readonly DemotionOp[]): Promise<TidyOutcome> {
    return applyDemotions(this.tidy(), subscription, ops);
  }

  /** What the demotion helpers need, bound to this service's own gateways. */
  private tidy(): TidyDeps {
    return {
      vault: this.deps.vault,
      state: this.deps.state,
      logger: this.deps.logger,
      record: (subscriptionId, page) => this.record(subscriptionId, page),
    };
  }

  /** Whether the note's Markdown survives a round trip, and the storage it produces. */
  private representable(
    subscription: Subscription,
    connection: ConnectionProfile,
    body: string,
  ): Result<string, AppError> {
    const options = conversionOptionsFor(
      {
        baseUrl: connection.baseUrl,
        spaceKey: subscription.spaceKey,
        strictMarkup: connection.strictMarkup,
        resolveTarget: this.linkIndex().resolveTarget,
        resolveVaultPath: this.linkIndex().resolveVaultPath,
      },
      {},
    );

    const checked = verify(body, new Map(), options);
    if (!checked.ok) return checked;
    if (!checked.value.verified) {
      return err(
        new AppError(
          'VERIFICATION_FAILED',
          'This note holds something that cannot be written to Confluence without changing ' +
            'it, so the page was not created. Simplify the note and try again.',
          { action: 'show-diff' },
        ),
      );
    }

    const storage = markdownToStorage(body, new Map(), options);
    return storage.ok ? ok(storage.value) : storage;
  }

  /** What the placement helpers need, bound to this service's own gateways. */
  private placement(): PlacementDeps {
    return {
      vault: this.deps.vault,
      state: this.deps.state,
      logger: this.deps.logger,
      record: (subscriptionId, page) => this.record(subscriptionId, page),
    };
  }

  /** Writes a freshly created page through the ordinary pull path. */
  private async writeCreated(
    subscription: Subscription,
    connection: ConnectionProfile,
    client: ConfluenceGateway,
    pageId: string,
    target: {
      path: string;
      isFolderNote: boolean;
      alias: string | null;
      labels: readonly string[];
    },
  ): Promise<Result<PageState, AppError>> {
    const pulled = await pullSinglePage(
      singlePageExecutor(this.deps, subscription, connection, client),
      pageId,
      target,
    );
    if (!pulled.ok) return pulled;

    await this.record(subscription.id, pulled.value.state);
    return ok(pulled.value.state);
  }

  private connectionFor(subscription: Subscription): Result<ConnectionProfile, AppError> {
    const connection = this.deps.settings
      .get()
      .connections.find((candidate) => candidate.id === subscription.connectionId);

    return connection === undefined
      ? err(
          new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.', {
            action: 'open-settings',
          }),
        )
      : ok(connection);
  }

  private linkIndex(): LinkIndex {
    return new LinkIndex(
      mirroredPages(this.deps.settings.get().subscriptions, (id) =>
        this.deps.state.forSubscription(id),
      ),
    );
  }

  private async record(subscriptionId: string, page: PageState): Promise<void> {
    const current = this.deps.state.forSubscription(subscriptionId);
    await this.deps.state.replace(subscriptionId, {
      ...current,
      pages: { ...current.pages, [page.pageId]: page },
    });
  }

  private async forget(subscriptionId: string, pageId: string): Promise<void> {
    const current = this.deps.state.forSubscription(subscriptionId);
    const { [pageId]: _removed, ...rest } = current.pages;
    await this.deps.state.replace(subscriptionId, { ...current, pages: rest });
  }
}

/** A note's title, as its file name states it. */
function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
