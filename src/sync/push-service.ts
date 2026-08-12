import type { ConfluenceGateway } from '../api/confluence-client';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import type { VaultGateway } from '../vault/vault-gateway';
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
import { pullHooks } from './pull-hooks';
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
  /**
   * Pages that *were* published, with something that did not go with them.
   *
   * A label call that failed, or a tag Confluence cannot hold (FR-9.2). Separate
   * from `blocked` because the distinction matters to the reader: the page is in
   * Confluence, and one piece of metadata is not.
   */
  readonly warnings: readonly PushFailure[];
  readonly conflicts: readonly ConflictOutcome[];
  /** Unmodified notes. No request was made for any of them (US-4). */
  readonly skipped: number;
  /**
   * Whether the user stopped the batch part-way (FR-10.6).
   *
   * Reported rather than raised as an error: everything already pushed is pushed,
   * and calling that a failure would hide work the user can see in Confluence.
   */
  readonly cancelled: boolean;
}

/**
 * Progress and cancellation for a batch push (spec FR-10.6, §7.1).
 *
 * A push of one note needs neither. A push of a whole subscription is the second
 * genuinely long operation in the plugin, and — unlike a sync — its slowest pages
 * may do no I/O at all: a page blocked by fidelity or verification is converted and
 * refused entirely on the main thread, so a subscription full of degraded pages would
 * run hundreds of conversions in one uninterrupted task.
 */
export interface PushProgress {
  readonly onProgress?: (done: number, total: number) => void;
  readonly isCancelled?: () => boolean;
}

/** Hands the main thread back between pages so the UI stays inside the §7.1 budget. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

    // The path the user invoked on, not the one the index remembers: this command is
    // reached from a note that is open, and if they moved it since the last sync the
    // recorded path names a file that is no longer there.
    const target =
      previous.localPath === notePath ? previous : { ...previous, localPath: notePath };
    return ok(await this.run(subscription, connection, [target], prompts));
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
    progress: PushProgress = {},
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
    // Located by *identity*, as the pull planner locates the same notes: matching on
    // the recorded path instead loses a note the user has both edited and moved, and
    // loses it silently — it is not pushed, not blocked and not even counted as
    // skipped, so the report says nothing about the edit that stayed behind.
    const byId = new Map(
      scanned.value.flatMap((note) =>
        note.isConflictCopy || note.identity === null ? [] : [[note.identity.id, note] as const],
      ),
    );

    const modified: PageState[] = [];
    let skipped = 0;
    for (const state of Object.values(pages)) {
      const note = byId.get(state.pageId);
      // A note that is gone is an orphan, which D6 says is never a remote action.
      if (note === undefined) continue;
      if (note.hash === state.localHash) skipped += 1;
      // Pushed at the path the file is *at*: the recorded one may name where the user
      // moved it from, and the push reads and rewrites the file by that path.
      else
        modified.push(note.path === state.localPath ? state : { ...state, localPath: note.path });
    }

    const report = await this.run(subscription, connection, modified, prompts, progress);
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
    progress: PushProgress = {},
  ): Promise<PushReport> {
    const client = this.deps.createClient(connection);
    const push = this.pushDeps(subscription, connection, client);

    const pushed: PushedPage[] = [];
    const blocked: PushFailure[] = [];
    const warnings: PushFailure[] = [];
    const conflicts: PageConflict[] = [];
    const states = new Map<string, PageState>();

    let cancelled = false;
    for (const [index, state] of pages.entries()) {
      // Checked before the page rather than after: a user who stops the push has
      // said "no more", and one further page would be one more edit published.
      if (progress.isCancelled?.() === true) {
        cancelled = true;
        break;
      }
      progress.onProgress?.(index, pages.length);

      const outcome = await this.pushOne(push, subscription, state, prompts);

      if (outcome.kind === 'pushed') {
        states.set(outcome.state.pageId, outcome.state);
        pushed.push(named(outcome.state));
        for (const error of outcome.warnings) {
          warnings.push({ ...named(outcome.state), error });
        }
      } else if (outcome.kind === 'conflict') {
        conflicts.push(outcome.conflict);
      } else {
        blocked.push({ ...named(state), error: outcome.blocked.error });
      }

      // A blocked page does no I/O at all, so without this a subscription of
      // degraded pages would convert every one of them in a single task (§7.1).
      await yieldToUi();
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
    progress.onProgress?.(pages.length, pages.length);
    return { pushed, blocked, warnings, conflicts: resolved, skipped: 0, cancelled };
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
      ...pullHooks({
        client,
        vault: this.deps.vault,
        logger: this.deps.logger,
        subscription,
        attachmentLimitBytes: settings.attachmentSizeLimitMb * 1_048_576,
        attachmentsReferencedOnly: settings.attachmentsReferencedOnly,
        recorded: (pageId) =>
          this.deps.state.forSubscription(subscription.id).pages[pageId]?.attachments ?? {},
      }),
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
