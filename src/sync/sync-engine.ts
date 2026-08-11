import type { ConfluenceGateway } from '../api/confluence-client';
import type { ConfluencePageRef } from '../api/api-types';
import type { Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { buildPathMap, type PathMap } from '../vault/path-mapper';
import type { VaultGateway } from '../vault/vault-gateway';
import { attachmentHook } from './attachment-executor';
import type { BackupStore } from './backup-store';
import { conflictPhase, type ConflictPhaseResult } from './conflict-phase';
import { nextSubscriptionState, type AppliedSync } from './sync-persist';
import { buildSyncReport } from './sync-report';
import type { FragmentStore } from './fragment-store';
import { LinkIndex, linkPath, type MirroredPage } from './link-index';
import { deletePages, pullPages, relocate, type ExecutorDeps } from './pull-executor';
import { buildPullPlan, type PullPlan } from './pull-planner';
import { isSuspendingError, type SuspensionRegistry } from './suspension';
import type { SyncStateStore } from './sync-state';
import type { SyncCallbacks, SyncFailure, SyncReport } from './sync-types';

/**
 * Sync orchestration (spec §6.6.2).
 *
 * All the business logic and none of the I/O: every side effect goes through
 * `ConfluenceClient` or `VaultGateway`, which is what lets the whole engine be
 * tested end to end with no network and no file system (spec §7.5).
 *
 * Pulling is the whole of a sync's *automatic* behaviour. A sync never pushes on
 * its own initiative: §6.6.2's push step is reached only through an answer the
 * user gave to a conflict — "Keep Local" — or through the explicit push commands
 * in `PushService` (FR-5.1, FR-5.6). Publishing a typo to a corporate wiki because
 * somebody pressed Sync is exactly what §1.2's "when in doubt, read" rules out.
 */

export interface SyncEngineDeps {
  readonly vault: VaultGateway;
  readonly state: SyncStateStore;
  readonly fragments: FragmentStore;
  readonly suspensions: SuspensionRegistry;
  /** Copies a note aside before a conflict resolution overwrites it (FR-6.6). */
  readonly backups: BackupStore;
  readonly logger: Logger;
  /** Injected so reports and state records are deterministic under test (§7.5). */
  readonly now: () => string;
}

export interface SyncRequest {
  readonly subscription: Subscription;
  readonly client: ConfluenceGateway;
  readonly baseUrl: string;
  /** The connection's byte-faithful setting, carried to conversion (FR-4.12). */
  readonly strictMarkup: boolean;
  /**
   * Pages other subscriptions already mirror, so a link across spaces can still
   * become a wikilink (FR-4.7). The engine layers this sync's own placements on
   * top.
   */
  readonly mirrored?: readonly MirroredPage[];
  /** Attachment settings, from the plugin's own configuration (FR-8.4, FR-8.5). */
  readonly attachmentLimitBytes: number;
  readonly attachmentsReferencedOnly: boolean;
}

/**
 * Where every mirrored page lives, for wikilink resolution (FR-4.7).
 *
 * This sync's own placements go last so they win: a page being moved right now
 * must resolve to where it is going, not to where the index still has it.
 */
function links(
  request: SyncRequest,
  remote: readonly ConfluencePageRef[],
  paths: PathMap,
): LinkIndex {
  const here = remote.flatMap((page) => {
    const mapped = paths.byId.get(page.id);
    if (mapped === undefined) return [];
    return [{ spaceKey: page.spaceKey, title: page.title, path: linkPath(mapped.notePath) }];
  });

  return new LinkIndex([...(request.mirrored ?? []), ...here]);
}

export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  async sync(
    request: SyncRequest,
    callbacks: SyncCallbacks = {},
  ): Promise<Result<SyncReport, AppError>> {
    const suspension = this.deps.suspensions.get(request.subscription.connectionId);
    if (suspension !== null) {
      return err(
        new AppError('AUTH_FAILED', `Sync is suspended for this connection: ${suspension.reason}`, {
          action: 'open-settings',
        }),
      );
    }

    const preflight = await this.preflight(request, callbacks);
    if (!preflight.ok) return this.fail(request, preflight.error);

    const remote = await this.discover(request, callbacks);
    if (!remote.ok) return this.fail(request, remote.error);

    const root = await this.resolveRoot(request);
    if (!root.ok) return this.fail(request, root.error);

    const folder = request.subscription.mountPath;
    callbacks.onProgress?.({ phase: 'scanning', done: 0, total: null, detail: folder });
    const local = await this.deps.vault.scan(folder);
    if (!local.ok) return err(local.error);

    const paths = this.mapPaths(request, remote.value, root.value);
    const plan = buildPullPlan({
      remote: remote.value,
      local: local.value,
      state: this.deps.state.forSubscription(request.subscription.id),
      paths,
    });

    return ok(await this.apply(request, plan, links(request, remote.value, paths), callbacks));
  }

  /**
   * The page that collapses into the mount folder (D13): the subscription's own
   * root for a subtree, or the space's home page for a whole space.
   */
  private async resolveRoot(request: SyncRequest): Promise<Result<string | null, AppError>> {
    const explicit = request.subscription.rootPageId;
    if (explicit !== null) return ok(explicit);

    return request.client.spaceHomepageId(request.subscription.spaceKey);
  }

  /** Verifies credentials and version before anything is written (§6.6.2 step 1). */
  private async preflight(
    request: SyncRequest,
    callbacks: SyncCallbacks,
  ): Promise<Result<void, AppError>> {
    callbacks.onProgress?.({
      phase: 'preflight',
      done: 0,
      total: null,
      detail: 'Checking the connection',
    });

    const check = await request.client.checkConnection();
    if (!check.ok) return check;

    if (!check.value.versionSupported) {
      return err(
        new AppError(
          'VERSION_UNSUPPORTED',
          `This Confluence is version ${check.value.version?.raw ?? 'unknown'}. Personal Access ` +
            'Tokens need Data Center 7.9 or newer, so this connection cannot be synced.',
          { action: 'open-docs' },
        ),
      );
    }
    return ok(undefined);
  }

  private async discover(
    request: SyncRequest,
    callbacks: SyncCallbacks,
  ): Promise<Result<readonly ConfluencePageRef[], AppError>> {
    callbacks.onProgress?.({
      phase: 'discovering',
      done: 0,
      total: null,
      detail: request.subscription.spaceKey,
    });

    const options = {
      onProgress: (collected: number) => {
        callbacks.onProgress?.({
          phase: 'discovering',
          done: collected,
          total: null,
          detail: `${String(collected)} pages found`,
        });
      },
      ...(callbacks.isCancelled === undefined ? {} : { isCancelled: callbacks.isCancelled }),
    };

    return request.client.listSubtree(
      request.subscription.spaceKey,
      request.subscription.rootPageId,
      options,
    );
  }

  private mapPaths(
    request: SyncRequest,
    remote: readonly ConfluencePageRef[],
    rootPageId: string | null,
  ): PathMap {
    const previous = this.deps.state.forSubscription(request.subscription.id);

    return buildPathMap(remote, {
      mountPath: request.subscription.mountPath,
      rootPageId,
      vaultPathLength: this.deps.vault.vaultPathLength(),
      keepAsFolderNote: new Set(
        Object.values(previous.pages)
          .filter((page) => page.isFolderNote)
          .map((page) => page.pageId),
      ),
    });
  }

  /** Everything the executor needs, for one subscription's sync. */
  private executorFor(request: SyncRequest, linkIndex: LinkIndex): ExecutorDeps {
    return {
      client: request.client,
      vault: this.deps.vault,
      fragments: this.deps.fragments,
      logger: this.deps.logger,
      baseUrl: request.baseUrl,
      strictMarkup: request.strictMarkup,
      resolveTarget: linkIndex.resolveTarget,
      resolveVaultPath: linkIndex.resolveVaultPath,
      attachments: attachmentHook(
        {
          client: request.client,
          vault: this.deps.vault,
          logger: this.deps.logger,
          mountPath: request.subscription.mountPath,
          sizeLimitBytes: request.attachmentLimitBytes,
          referencedOnly: request.attachmentsReferencedOnly,
        },
        (pageId) =>
          this.deps.state.forSubscription(request.subscription.id).pages[pageId]?.attachments ?? {},
      ),
      now: this.deps.now,
    };
  }

  private async apply(
    request: SyncRequest,
    plan: PullPlan,
    linkIndex: LinkIndex,
    callbacks: SyncCallbacks,
  ): Promise<SyncReport> {
    const executor = this.executorFor(request, linkIndex);
    const failures: SyncFailure[] = [];

    // Step 5 before step 6: a "Keep Remote" answer discards local edits, and
    // asking for it after the sync had started rewriting notes would be asking
    // about a state that no longer exists.
    const resolved = await this.resolveConflicts(request, plan, executor, callbacks);
    failures.push(...resolved.failures);

    const relocated = await this.relocateAll(executor, plan, failures);
    const deleted = await this.deleteAll(executor, plan, callbacks, failures);

    const pulled = await pullPages(executor, plan.pull, {
      onPage: (done, total) => {
        callbacks.onProgress?.({ phase: 'applying', done, total, detail: 'Writing pages' });
      },
      ...(callbacks.isCancelled === undefined ? {} : { isCancelled: callbacks.isCancelled }),
    });
    failures.push(...pulled.failures);

    await this.persist(
      request,
      {
        relocated,
        deleted,
        // Conflict outcomes first, so a page the sync also pulled ends on the
        // pull's record rather than the resolution's — they cannot both be right,
        // and the pull is the later write.
        states: [
          ...resolved.outcomes.flatMap((o) => (o.state === null ? [] : [o.state])),
          ...pulled.states,
        ],
      },
      plan,
    );

    return buildSyncReport({
      subscriptionId: request.subscription.id,
      plan,
      conflicts: resolved,
      relocated: relocated.length,
      deleted: deleted.length,
      pulled,
      failures,
      cancelled: callbacks.isCancelled?.() === true,
      finishedAt: this.deps.now(),
    });
  }

  /** The conflict step (spec §6.6.2 step 5, FR-6.2, FR-6.5). */
  private resolveConflicts(
    request: SyncRequest,
    plan: PullPlan,
    executor: ExecutorDeps,
    callbacks: SyncCallbacks,
  ): Promise<ConflictPhaseResult> {
    const { spaceKey } = request.subscription;

    return conflictPhase(
      {
        push: { ...executor, spaceKey },
        pull: executor,
        backups: this.deps.backups,
      },
      {
        conflicts: plan.conflicts,
        pages: this.deps.state.forSubscription(request.subscription.id).pages,
        spaceKey,
        resolve: callbacks.resolveConflicts,
      },
    );
  }

  private async relocateAll(
    executor: ExecutorDeps,
    plan: PullPlan,
    failures: SyncFailure[],
  ): Promise<PullPlan['relocate']> {
    const done: PullPlan['relocate'][number][] = [];

    for (const item of plan.relocate) {
      const error = await relocate(executor, item);
      if (error === null) done.push(item);
      else failures.push({ pageId: item.pageId, title: item.title, error });
    }
    return done;
  }

  /** Never removes anything the user has not been shown and agreed to (FR-3.5). */
  private async deleteAll(
    executor: ExecutorDeps,
    plan: PullPlan,
    callbacks: SyncCallbacks,
    failures: SyncFailure[],
  ): Promise<PullPlan['deleteLocal']> {
    if (plan.deleteLocal.length === 0) return [];

    const confirmed = (await callbacks.confirmDeletions?.(plan.deleteLocal)) ?? false;
    if (!confirmed) {
      this.deps.logger.debug(`Kept ${String(plan.deleteLocal.length)} page(s) the user declined.`);
      return [];
    }

    failures.push(...(await deletePages(executor, plan.deleteLocal)));
    return plan.deleteLocal;
  }

  private async persist(
    request: SyncRequest,
    applied: Omit<AppliedSync, 'forget'>,
    plan: PullPlan,
  ): Promise<void> {
    const next = nextSubscriptionState(
      this.deps.state.forSubscription(request.subscription.id),
      { ...applied, forget: plan.forget },
      this.deps.now(),
    );

    const saved = await this.deps.state.replace(request.subscription.id, next);
    if (!saved.ok) this.deps.logger.warn(saved.error.userMessage);
  }

  /** Records an authentication failure as a suspension before returning it (FR-1.8). */
  private fail(request: SyncRequest, error: AppError): Result<SyncReport, AppError> {
    if (isSuspendingError(error)) {
      this.deps.suspensions.suspend(
        request.subscription.connectionId,
        error.userMessage,
        this.deps.now(),
      );
    }
    return err(error);
  }
}
