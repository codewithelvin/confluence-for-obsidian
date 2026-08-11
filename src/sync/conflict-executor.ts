import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import { conflictCopyPath, pageUrl, type ConflictCopy } from '../vault/frontmatter';
import type { BackupStore } from './backup-store';
import { pullSinglePage, type ExecutorDeps } from './pull-executor';
import {
  pushPage,
  type PageConflict,
  type PushBlocked,
  type PushDeps,
  type PushTarget,
} from './push-executor';
import type { PageState } from './sync-state';

/**
 * Applying the user's answer to a conflict (spec §3.6, decision D4).
 *
 * There is no merge here and there never will be: D4 makes every conflict an
 * explicit three-way choice, precisely so that no code ever has to guess which
 * of two people's edits was meant to win.
 *
 * The one invariant worth stating on its own: **nothing overwrites a local file
 * until its backup is on disk** (FR-6.6). A backup that fails cancels the
 * resolution rather than proceeding without it.
 */

/** The three choices FR-6.2 offers, plus leaving the conflict for later. */
export type ConflictChoice = 'keep-local' | 'keep-remote' | 'save-both' | 'skip';

/**
 * Both halves of a resolution, because the three choices pull in two directions:
 * "Keep Local" is a push and "Keep Remote" is a pull.
 *
 * The two dependency sets carry the same `vault`, `client` and clock; everything
 * here reads them from `push` so there is one answer to "which vault" rather than
 * two that could drift apart.
 */
export interface ConflictDeps {
  /** Dependencies for the push half of "Keep Local". */
  readonly push: PushDeps;
  /** Dependencies for the re-pull half of "Keep Remote". */
  readonly pull: ExecutorDeps;
  readonly backups: BackupStore;
}

export interface ConflictOutcome {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  readonly choice: ConflictChoice;
  /** The index record the resolution produced, or `null` if it produced none. */
  readonly state: PageState | null;
  /** Where the snapshot was written, for "Save Both" (FR-6.4). */
  readonly copyPath: string | null;
  readonly error: AppError | null;
  /** Set when "Keep Local" was itself stopped by verification (FR-5.2). */
  readonly blocked: PushBlocked | null;
}

/** One resolution, as the modal reports it back. */
export interface ConflictDecision {
  readonly conflict: PageConflict;
  readonly choice: ConflictChoice;
}

function outcome(
  decision: ConflictDecision,
  extra: Partial<Omit<ConflictOutcome, 'pageId' | 'title' | 'path' | 'choice'>> = {},
): ConflictOutcome {
  return {
    pageId: decision.conflict.pageId,
    title: decision.conflict.title,
    path: decision.conflict.path,
    choice: decision.choice,
    state: null,
    copyPath: null,
    error: null,
    blocked: null,
    ...extra,
  };
}

/**
 * Publishes the local version onto whatever Confluence currently holds (FR-6.4).
 *
 * `ontoVersion` is the version the user was *shown* in the modal, not the one the
 * index remembers: they have seen the remote change and chosen to supersede it.
 * Verification still applies — choosing to overwrite a colleague is one decision,
 * and writing a body the plugin cannot reproduce is a different one.
 */
async function keepLocal(
  deps: ConflictDeps,
  decision: ConflictDecision,
  target: PushTarget,
): Promise<ConflictOutcome> {
  const pushed = await pushPage(deps.push, target, {
    ontoVersion: decision.conflict.remoteVersion,
  });

  if (pushed.kind === 'pushed') return outcome(decision, { state: pushed.state });
  if (pushed.kind === 'blocked') {
    return outcome(decision, { error: pushed.blocked.error, blocked: pushed.blocked });
  }

  // A second conflict between the modal opening and the answer arriving: somebody
  // edited the page again. Reported rather than retried, because the diff the user
  // just read is no longer the diff in front of them.
  return outcome(decision, {
    error: new AppError(
      'CONFLICT',
      `"${decision.conflict.title}" changed in Confluence again while the conflict was open. ` +
        'Sync it and look at the new difference before pushing.',
      { action: 'retry' },
    ),
  });
}

/** Replaces the local note with the remote version, after backing it up (FR-6.4, FR-6.6). */
async function keepRemote(
  deps: ConflictDeps,
  decision: ConflictDecision,
  state: PageState,
): Promise<ConflictOutcome> {
  const backed = await backUp(deps, state.localPath);
  if (backed !== null) return outcome(decision, { error: backed });

  const pulled = await pullSinglePage(deps.pull, state.pageId, {
    path: state.localPath,
    isFolderNote: state.isFolderNote,
    alias: state.alias,
  });

  return pulled.ok
    ? outcome(decision, { state: pulled.value })
    : outcome(decision, { error: pulled.error });
}

/**
 * Keeps both: the local note as it is, and the remote version beside it (FR-6.4).
 *
 * The index is advanced to the remote version even though the note still holds the
 * user's text. That is the honest record — they have now seen that version, it is
 * sitting next to them — and it is what stops the same conflict being raised on
 * every subsequent sync forever. The page stays *locally modified*, so it appears
 * under "Edited locally" until the user merges and pushes.
 */
async function saveBoth(
  deps: ConflictDeps,
  decision: ConflictDecision,
  state: PageState,
  spaceKey: string,
): Promise<ConflictOutcome> {
  const { conflict } = decision;
  const path = conflictCopyPath(state.localPath, conflict.remoteVersion);

  const copy: ConflictCopy = {
    pageId: conflict.pageId,
    space: spaceKey,
    version: conflict.remoteVersion,
    updated: conflict.remoteUpdatedAt,
    updatedBy: conflict.remoteUpdatedBy,
    url: pageUrl(deps.push.baseUrl, conflict.pageId),
  };

  const written = await deps.push.vault.writeConflictCopy(path, conflict.remoteBody, copy);
  if (!written.ok) return outcome(decision, { error: written.error });

  return outcome(decision, {
    copyPath: path,
    state: {
      ...state,
      remoteVersion: conflict.remoteVersion,
      storageHash: await sha256(conflict.remoteStorage),
      lastSyncedAt: deps.push.now(),
    },
  });
}

/** `null` when the previous bytes are safely aside, otherwise why they are not. */
async function backUp(deps: ConflictDeps, notePath: string): Promise<AppError | null> {
  const content = await deps.push.vault.read(notePath);
  if (!content.ok) return content.error;

  const saved = await deps.backups.save(notePath, content.value);
  return saved.ok ? null : saved.error;
}

/**
 * Applies one decision.
 *
 * `skip` is a real answer, not an absence of one: the conflict stays, the note is
 * untouched, and the next sync raises it again.
 */
export async function resolveConflict(
  deps: ConflictDeps,
  decision: ConflictDecision,
  state: PageState,
  spaceKey: string,
): Promise<ConflictOutcome> {
  switch (decision.choice) {
    case 'keep-local':
      return keepLocal(deps, decision, { state, spaceKey });
    case 'keep-remote':
      return keepRemote(deps, decision, state);
    case 'save-both':
      return saveBoth(deps, decision, state, spaceKey);
    case 'skip':
      return outcome(decision);
  }
}
