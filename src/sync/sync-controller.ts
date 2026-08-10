import type { ConfluenceGateway } from '../api/confluence-client';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { spaceFolderPath } from '../vault/path-mapper';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import type { FragmentStore } from './fragment-store';
import { pullSinglePage } from './pull-executor';
import { SyncEngine, type SyncEngineDeps } from './sync-engine';
import type { PageState, SyncStateStore } from './sync-state';
import type { SyncCallbacks, SyncProgress, SyncReport } from './sync-types';
import { checkSubscriptionTarget, type SubscriptionCheck } from './subscription-service';
import type { SubscriptionDraft } from './subscription-validator';
import type { SuspensionRegistry } from './suspension';

/**
 * One place the UI and the command palette both talk to (spec §6.1).
 *
 * It owns *when* a sync runs — one at a time, cancellable, with the last report
 * kept so the Sync Panel is a pure view over state rather than a second copy of
 * the orchestration.
 */

export interface SyncControllerDeps extends SyncEngineDeps {
  readonly settings: SettingsStore;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly state: SyncStateStore;
  readonly suspensions: SuspensionRegistry;
  readonly logger: Logger;
  readonly newId: () => string;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceGateway;
}

/** What the panel and the status bar render. */
export interface SyncStatus {
  readonly running: Subscription | null;
  readonly progress: SyncProgress | null;
  readonly reports: ReadonlyMap<string, SyncReport>;
}

/**
 * Whether a path is the `Title/Title.md` form (decision D9).
 *
 * Only used when the index has no record of the note — otherwise the recorded
 * flag wins, because it is what stops an automatic demotion.
 */
function isFolderNotePath(path: string): boolean {
  const folder = parentPath(path);
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return folder.slice(folder.lastIndexOf('/') + 1) === name;
}

export class SyncController {
  private readonly engine: SyncEngine;
  private readonly reports = new Map<string, SyncReport>();
  private readonly listeners = new Set<() => void>();
  private running: Subscription | null = null;
  private progress: SyncProgress | null = null;
  private cancelled = false;

  constructor(private readonly deps: SyncControllerDeps) {
    this.engine = new SyncEngine(deps);
  }

  /** Reads the sync index. Called once at startup, before anything renders. */
  async load(): Promise<void> {
    const loaded = await this.deps.state.load();
    if (!loaded.ok) this.deps.logger.warn(loaded.error.userMessage);
  }

  status(): SyncStatus {
    return { running: this.running, progress: this.progress, reports: this.reports };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  lastSyncedAt(subscriptionId: string): string | null {
    return this.deps.state.forSubscription(subscriptionId).lastSyncedAt;
  }

  /**
   * Asks the running sync to stop at the next page boundary (FR-3.4).
   *
   * Idempotent: a second call is ignored rather than re-notifying. A listener
   * that cancels in response to a progress update would otherwise drive the
   * notification back into itself.
   */
  cancel(): void {
    if (this.cancelled || this.running === null) return;
    this.cancelled = true;
    this.emit();
  }

  connectionFor(subscription: Subscription): ConnectionProfile | null {
    return (
      this.deps.settings
        .get()
        .connections.find((connection) => connection.id === subscription.connectionId) ?? null
    );
  }

  /** Version and size checks for a subscription about to be created (FR-1.7, FR-2.4). */
  async check(draft: SubscriptionDraft): Promise<Result<SubscriptionCheck, AppError>> {
    const connection = this.deps.settings
      .get()
      .connections.find((candidate) => candidate.id === draft.connectionId);
    if (connection === undefined) {
      return err(new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.'));
    }

    return checkSubscriptionTarget(
      this.deps.createClient(connection),
      draft,
      this.deps.settings.get().pageCountWarningThreshold,
    );
  }

  async create(draft: SubscriptionDraft): Promise<Subscription> {
    const subscription: Subscription = {
      id: this.deps.newId(),
      connectionId: draft.connectionId,
      spaceKey: draft.spaceKey,
      rootPageId: draft.rootPageId,
      mountPath: draft.mountPath,
      syncComments: true,
    };

    const { subscriptions } = this.deps.settings.get();
    await this.deps.settings.update({ subscriptions: [...subscriptions, subscription] });
    return subscription;
  }

  /**
   * Removes a subscription, optionally deleting the mirrored files (FR-2.6).
   *
   * Confluence is never touched: unsubscribing is a local decision, and D6
   * keeps local deletions from ever reaching the server.
   */
  async remove(subscription: Subscription, deleteFiles: boolean): Promise<Result<void, AppError>> {
    if (deleteFiles) {
      const folder = spaceFolderPath(subscription.mountPath, subscription.spaceKey);
      const trashed = await this.deps.vault.trash(folder);
      if (!trashed.ok) return trashed;
    }

    for (const pageId of Object.keys(this.deps.state.forSubscription(subscription.id).pages)) {
      await this.deps.fragments.remove(pageId);
    }
    await this.deps.state.forget(subscription.id);

    const remaining = this.deps.settings
      .get()
      .subscriptions.filter((candidate) => candidate.id !== subscription.id);
    await this.deps.settings.update({ subscriptions: remaining });

    this.reports.delete(subscription.id);
    this.emit();
    return ok(undefined);
  }

  /**
   * Syncs one subscription. Refuses to start a second while one is running:
   * two syncs sharing a mount would each see the other's half-written files.
   */
  async sync(
    subscription: Subscription,
    callbacks: SyncCallbacks = {},
  ): Promise<Result<SyncReport, AppError>> {
    if (this.running !== null) {
      return err(
        new AppError('UNKNOWN', `A sync of ${this.running.spaceKey} is already running.`, {
          action: 'retry',
        }),
      );
    }

    const connection = this.connectionFor(subscription);
    if (connection === null) {
      return err(
        new AppError(
          'CREDENTIALS_UNAVAILABLE',
          `${subscription.spaceKey} points at a connection that no longer exists.`,
          { action: 'open-settings' },
        ),
      );
    }

    this.running = subscription;
    this.cancelled = false;
    this.emit();

    try {
      return await this.run(subscription, connection, callbacks);
    } finally {
      this.running = null;
      this.progress = null;
      this.emit();
    }
  }

  private async run(
    subscription: Subscription,
    connection: ConnectionProfile,
    callbacks: SyncCallbacks,
  ): Promise<Result<SyncReport, AppError>> {
    const result = await this.engine.sync(
      { subscription, client: this.deps.createClient(connection), baseUrl: connection.baseUrl },
      {
        ...callbacks,
        onProgress: (progress) => {
          this.progress = progress;
          callbacks.onProgress?.(progress);
          this.emit();
        },
        isCancelled: () => this.cancelled || callbacks.isCancelled?.() === true,
      },
    );

    if (result.ok) {
      this.reports.set(subscription.id, result.value);
      this.deps.logger.debug(
        `${subscription.spaceKey}: ${String(result.value.pulled)} pulled, ` +
          `${String(result.value.failures.length)} failed`,
      );
    }
    return result;
  }

  /** The Confluence URL recorded in a note's frontmatter (spec FR-10.5). */
  pageUrlFor(notePath: string): string | null {
    const identity = this.deps.vault.readIdentity(notePath);
    if (identity === null) return null;
    return identity.url.length === 0 ? null : identity.url;
  }

  /** The subscription whose mount contains a note, or `null` for a personal note. */
  subscriptionFor(notePath: string): Subscription | null {
    return (
      this.deps.settings
        .get()
        .subscriptions.find(
          (subscription) =>
            notePath === subscription.mountPath ||
            notePath.startsWith(`${subscription.mountPath}/`),
        ) ?? null
    );
  }

  /**
   * Re-pulls the page behind one note (spec FR-3.8).
   *
   * Deliberately not routed through the full sync: the point of the command is
   * to refresh *this* page without waiting for an enumeration of the space.
   */
  async pullPage(notePath: string): Promise<Result<PageState, AppError>> {
    const subscription = this.subscriptionFor(notePath);
    if (subscription === null) {
      return err(
        new AppError('OUT_OF_MOUNT', 'This note is not inside a Confluence subscription.'),
      );
    }

    const identity = this.deps.vault.readIdentity(notePath);
    if (identity === null) {
      return err(
        new AppError('NOT_FOUND', 'This note has no Confluence page recorded in its frontmatter.'),
      );
    }

    const connection = this.connectionFor(subscription);
    if (connection === null) {
      return err(
        new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.', {
          action: 'open-settings',
        }),
      );
    }

    const previous = this.deps.state.forSubscription(subscription.id).pages[identity.id];
    const pulled = await pullSinglePage(
      {
        client: this.deps.createClient(connection),
        vault: this.deps.vault,
        fragments: this.deps.fragments,
        logger: this.deps.logger,
        baseUrl: connection.baseUrl,
        now: this.deps.now,
      },
      identity.id,
      notePath,
      previous?.isFolderNote ?? isFolderNotePath(notePath),
    );
    if (!pulled.ok) return pulled;

    await this.recordPage(subscription.id, pulled.value);
    return pulled;
  }

  private async recordPage(subscriptionId: string, page: PageState): Promise<void> {
    const current = this.deps.state.forSubscription(subscriptionId);
    await this.deps.state.replace(subscriptionId, {
      ...current,
      pages: { ...current.pages, [page.pageId]: page },
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
