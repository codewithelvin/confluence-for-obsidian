import type { ConfluenceGateway } from '../api/confluence-client';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import type { VaultGateway } from '../vault/vault-gateway';
import { attachmentHook } from './attachment-executor';
import type { BackupStore } from './backup-store';
import {
  resolveConflict,
  type ConflictDecision,
  type ConflictDeps,
  type ConflictOutcome,
} from './conflict-executor';
import type { FragmentStore } from './fragment-store';
import { LinkIndex, mirroredPages } from './link-index';
import { locateNote, type LocatorDeps } from './note-locator';
import type { ExecutorDeps } from './pull-executor';
import { pushPage, type PageConflict, type PushBlocked, type PushDeps } from './push-executor';
import type { PageState, SyncStateStore } from './sync-state';

/**
 * The write path (spec §3.5, §3.6, FR-5.6).
 *
 * Owns *which* pages get pushed and *when the user is asked something*; the
 * per-page mechanics live in `push-executor` and `conflict-executor`. Kept apart
 * from `SyncController`, which owns pulling, for the reason §6.6.2 gives about
 * ordering: a push has to establish for itself that the remote has not moved,
 * and that check belongs next to the push rather than to a sync that ran earlier.
 */

export interface PushServiceDeps extends LocatorDeps {
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly state: SyncStateStore;
  readonly backups: BackupStore;
  readonly logger: Logger;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceGateway;
  readonly now: () => string;
}

/** A page named the way the report and the panel want to show it. */
export interface PushedPage {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
}

export interface PushFailure extends PushedPage {
  readonly error: AppError;
}

export interface PushReport {
  readonly pushed: readonly PushedPage[];
  /** Pages a gate refused, each with the reason (FR-5.2, FR-5.3). */
  readonly blocked: readonly PushFailure[];
  readonly conflicts: readonly ConflictOutcome[];
  /** Unmodified notes. No request was made for any of them (US-4). */
  readonly skipped: number;
}

/**
 * The questions a push may have to ask.
 *
 * Supplied by the command layer, which owns the modals. Absent means "cannot
 * ask", and every default is the cautious one: no force, no resolution.
 */
export interface PushPrompts {
  /**
   * A push stopped by verification (FR-5.2). Resolve `true` to force it through
   * (FR-5.7) — the modal is responsible for the typed confirmation, and for only
   * offering it at all when the setting permits.
   */
  readonly onVerificationFailure?: (page: PushedPage, blocked: PushBlocked) => Promise<boolean>;
  /** Conflicts, presented together so one choice can cover all of them (FR-6.5). */
  readonly onConflicts?: (
    conflicts: readonly PageConflict[],
  ) => Promise<readonly ConflictDecision[]>;
}

function named(state: PageState): PushedPage {
  return { pageId: state.pageId, title: state.title, path: state.localPath };
}

export class PushService {
  constructor(private readonly deps: PushServiceDeps) {}

  /** Pushes the page behind one note (spec FR-5.6). */
  async pushNote(
    notePath: string,
    prompts: PushPrompts = {},
  ): Promise<Result<PushReport, AppError>> {
    const located = locateNote(this.deps, notePath);
    if (!located.ok) return located;

    const { subscription, connection, previous } = located.value;
    if (previous === undefined) {
      return err(
        new AppError(
          'FRAGMENT_MISSING',
          'This note is not in the sync index, so there is no version to push against. ' +
            'Sync the subscription first.',
          { action: 'repull-page' },
        ),
      );
    }

    return ok(await this.run(subscription, connection, [previous], prompts));
  }

  /**
   * Pushes every locally-modified note in a subscription (spec FR-5.6).
   *
   * The modified set is decided from content hashes before any request is made, so
   * an unmodified note costs nothing at all — US-4 asks for exactly that, and on a
   * space the size of EP it is the difference between one request and a thousand.
   */
  async pushSubscription(
    subscription: Subscription,
    prompts: PushPrompts = {},
  ): Promise<Result<PushReport, AppError>> {
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

    const scanned = await this.deps.vault.scan(subscription.mountPath);
    if (!scanned.ok) return scanned;

    const pages = this.deps.state.forSubscription(subscription.id).pages;
    const byPath = new Map(
      scanned.value.filter((note) => !note.isConflictCopy).map((note) => [note.path, note.hash]),
    );

    const modified: PageState[] = [];
    let skipped = 0;
    for (const state of Object.values(pages)) {
      const hash = byPath.get(state.localPath);
      // A note that is gone is an orphan, which D6 says is never a remote action.
      if (hash === undefined) continue;
      if (hash === state.localHash) skipped += 1;
      else modified.push(state);
    }

    const report = await this.run(subscription, connection, modified, prompts);
    return ok({ ...report, skipped });
  }

  private connectionFor(subscription: Subscription): ConnectionProfile | null {
    return (
      this.deps.settings
        .get()
        .connections.find((candidate) => candidate.id === subscription.connectionId) ?? null
    );
  }

  /**
   * Pushes a set of pages, then resolves whatever conflicts they turned up.
   *
   * Conflicts are collected and asked about *together* (FR-6.5) rather than one
   * modal per page: a batch push of a subtree somebody else has been working in
   * would otherwise be a sequence of interruptions with no overview.
   */
  private async run(
    subscription: Subscription,
    connection: ConnectionProfile,
    pages: readonly PageState[],
    prompts: PushPrompts,
  ): Promise<PushReport> {
    const client = this.deps.createClient(connection);
    const push = this.pushDeps(subscription, connection, client);

    const pushed: PushedPage[] = [];
    const blocked: PushFailure[] = [];
    const conflicts: PageConflict[] = [];
    const states = new Map<string, PageState>();

    for (const state of pages) {
      const outcome = await this.pushOne(push, subscription, state, prompts);

      if (outcome.kind === 'pushed') {
        states.set(outcome.state.pageId, outcome.state);
        pushed.push(named(outcome.state));
      } else if (outcome.kind === 'conflict') {
        conflicts.push(outcome.conflict);
      } else {
        blocked.push({ ...named(state), error: outcome.blocked.error });
      }
    }

    const resolved = await this.resolveAll(
      subscription,
      connection,
      client,
      push,
      conflicts,
      prompts,
    );
    for (const outcome of resolved) {
      if (outcome.state !== null) states.set(outcome.state.pageId, outcome.state);
    }

    await this.record(subscription.id, states);
    return { pushed, blocked, conflicts: resolved, skipped: 0 };
  }

  /** One page, with the force retry FR-5.7 allows once the user has confirmed it. */
  private async pushOne(
    push: PushDeps,
    subscription: Subscription,
    state: PageState,
    prompts: PushPrompts,
  ): Promise<Awaited<ReturnType<typeof pushPage>>> {
    const target = { state, spaceKey: subscription.spaceKey };
    const first = await pushPage(push, target);

    if (first.kind !== 'blocked' || first.blocked.error.code !== 'VERIFICATION_FAILED') {
      return first;
    }
    if (prompts.onVerificationFailure === undefined) return first;

    const forced = await prompts.onVerificationFailure(named(state), first.blocked);
    if (!forced) return first;

    this.deps.logger.warn(`Force-pushing "${state.title}" past a verification failure (FR-5.7).`);
    return pushPage(push, target, { force: true });
  }

  private async resolveAll(
    subscription: Subscription,
    connection: ConnectionProfile,
    client: ConfluenceGateway,
    push: PushDeps,
    conflicts: readonly PageConflict[],
    prompts: PushPrompts,
  ): Promise<readonly ConflictOutcome[]> {
    if (conflicts.length === 0 || prompts.onConflicts === undefined) return [];

    const decisions = await prompts.onConflicts(conflicts);
    const deps: ConflictDeps = {
      push,
      pull: this.pullDeps(subscription, connection, client, push),
      backups: this.deps.backups,
    };

    const outcomes: ConflictOutcome[] = [];
    const pages = this.deps.state.forSubscription(subscription.id).pages;

    for (const decision of decisions) {
      const state = pages[decision.conflict.pageId];
      if (state === undefined) continue;
      outcomes.push(await resolveConflict(deps, decision, state, subscription.spaceKey));
    }
    return outcomes;
  }

  /**
   * Link resolution spans every subscription, this one included: a push recomputes
   * no paths, so the index is exactly right about all of them (FR-4.7).
   */
  private linkIndex(): LinkIndex {
    return new LinkIndex(
      mirroredPages(this.deps.settings.get().subscriptions, (id) =>
        this.deps.state.forSubscription(id),
      ),
    );
  }

  private pushDeps(
    subscription: Subscription,
    connection: ConnectionProfile,
    client: ConfluenceGateway,
  ): PushDeps {
    const links = this.linkIndex();

    return {
      client,
      vault: this.deps.vault,
      fragments: this.deps.fragments,
      logger: this.deps.logger,
      baseUrl: connection.baseUrl,
      spaceKey: subscription.spaceKey,
      strictMarkup: connection.strictMarkup,
      resolveTarget: links.resolveTarget,
      resolveVaultPath: links.resolveVaultPath,
      now: this.deps.now,
    };
  }

  /** What "Keep Remote" needs: a full pull of one page, attachments included. */
  private pullDeps(
    subscription: Subscription,
    connection: ConnectionProfile,
    client: ConfluenceGateway,
    push: PushDeps,
  ): ExecutorDeps {
    const settings = this.deps.settings.get();

    return {
      ...push,
      attachments: attachmentHook(
        {
          client,
          vault: this.deps.vault,
          logger: this.deps.logger,
          mountPath: subscription.mountPath,
          sizeLimitBytes: settings.attachmentSizeLimitMb * 1_048_576,
          referencedOnly: settings.attachmentsReferencedOnly,
        },
        (pageId) =>
          this.deps.state.forSubscription(subscription.id).pages[pageId]?.attachments ?? {},
      ),
      baseUrl: connection.baseUrl,
    };
  }

  private async record(
    subscriptionId: string,
    states: ReadonlyMap<string, PageState>,
  ): Promise<void> {
    if (states.size === 0) return;

    const current = this.deps.state.forSubscription(subscriptionId);
    const saved = await this.deps.state.replace(subscriptionId, {
      ...current,
      pages: { ...current.pages, ...Object.fromEntries(states) },
    });
    if (!saved.ok) this.deps.logger.warn(saved.error.userMessage);
  }
}
