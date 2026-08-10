import type { ConfluenceGateway } from '../api/confluence-client';
import type { ConfluencePageRef } from '../api/api-types';
import type { Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { buildPathMap, spaceFolderPath, type PathMap } from '../vault/path-mapper';
import type { ScannedNote, VaultGateway } from '../vault/vault-gateway';
import type { FragmentStore } from './fragment-store';
import { deletePages, pullPages, relocate, type ExecutorDeps } from './pull-executor';
import { buildPullPlan, type PullPlan } from './pull-planner';
import { isSuspendingError, type SuspensionRegistry } from './suspension';
import type { PageState, SubscriptionState } from './sync-state';
import type { SyncStateStore } from './sync-state';
import type { SyncCallbacks, SyncFailure, SyncReport } from './sync-types';

/**
 * Sync orchestration (spec §6.6.2).
 *
 * All the business logic and none of the I/O: every side effect goes through
 * `ConfluenceClient` or `VaultGateway`, which is what lets the whole engine be
 * tested end to end with no network and no file system (spec §7.5).
 *
 * Read-only in M3. Pushing local edits, and resolving the conflicts this
 * reports, arrive with M5.
 */

export interface SyncEngineDeps {
  readonly vault: VaultGateway;
  readonly state: SyncStateStore;
  readonly fragments: FragmentStore;
  readonly suspensions: SuspensionRegistry;
  readonly logger: Logger;
  /** Injected so reports and state records are deterministic under test (§7.5). */
  readonly now: () => string;
}

export interface SyncRequest {
  readonly subscription: Subscription;
  readonly client: ConfluenceGateway;
  readonly baseUrl: string;
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

    const folder = spaceFolderPath(request.subscription.mountPath, request.subscription.spaceKey);
    callbacks.onProgress?.({ phase: 'scanning', done: 0, total: null, detail: folder });
    const local = await this.deps.vault.scan(folder);
    if (!local.ok) return err(local.error);

    return ok(await this.apply(request, this.plan(request, remote.value, local.value), callbacks));
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

  private plan(
    request: SyncRequest,
    remote: readonly ConfluencePageRef[],
    local: readonly ScannedNote[],
  ): PullPlan {
    const previous = this.deps.state.forSubscription(request.subscription.id);
    const paths: PathMap = buildPathMap(remote, {
      mountPath: request.subscription.mountPath,
      spaceKey: request.subscription.spaceKey,
      vaultPathLength: this.deps.vault.vaultPathLength(),
      keepAsFolderNote: new Set(
        Object.values(previous.pages)
          .filter((page) => page.isFolderNote)
          .map((page) => page.pageId),
      ),
    });

    return buildPullPlan({ remote, local, state: previous, paths });
  }

  private async apply(
    request: SyncRequest,
    plan: PullPlan,
    callbacks: SyncCallbacks,
  ): Promise<SyncReport> {
    const executor: ExecutorDeps = {
      client: request.client,
      vault: this.deps.vault,
      fragments: this.deps.fragments,
      logger: this.deps.logger,
      baseUrl: request.baseUrl,
      now: this.deps.now,
    };

    const failures: SyncFailure[] = [];
    const relocated = await this.relocateAll(executor, plan, failures);
    const deleted = await this.deleteAll(executor, plan, callbacks, failures);

    const pulled = await pullPages(executor, plan.pull, {
      onPage: (done, total) => {
        callbacks.onProgress?.({ phase: 'applying', done, total, detail: 'Writing pages' });
      },
      ...(callbacks.isCancelled === undefined ? {} : { isCancelled: callbacks.isCancelled }),
    });
    failures.push(...pulled.failures);

    await this.persist(request, plan, { relocated, deleted, states: pulled.states });

    return {
      subscriptionId: request.subscription.id,
      pulled: pulled.states.length,
      relocated: relocated.length,
      deleted: deleted.length,
      unchanged: plan.unchanged,
      degraded: pulled.degraded,
      conflicts: plan.conflicts,
      localEdits: plan.localEdits,
      orphans: plan.orphans,
      untracked: plan.untracked,
      truncated: plan.truncated,
      unmappable: plan.unmappable,
      failures,
      cancelled: callbacks.isCancelled?.() === true,
      finishedAt: this.deps.now(),
    };
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
    plan: PullPlan,
    applied: {
      relocated: PullPlan['relocate'];
      deleted: PullPlan['deleteLocal'];
      states: readonly PageState[];
    },
  ): Promise<void> {
    const pages = new Map(
      Object.entries(this.deps.state.forSubscription(request.subscription.id).pages),
    );

    for (const item of applied.relocated) {
      const previous = pages.get(item.pageId);
      if (previous !== undefined) {
        pages.set(item.pageId, {
          ...previous,
          localPath: item.to,
          title: item.title,
          isFolderNote: item.isFolderNote,
        });
      }
    }
    for (const state of applied.states) pages.set(state.pageId, state);
    for (const page of applied.deleted) pages.delete(page.pageId);
    for (const pageId of plan.forget) pages.delete(pageId);

    const next: SubscriptionState = {
      lastSyncedAt: this.deps.now(),
      pages: Object.fromEntries(pages),
    };
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
