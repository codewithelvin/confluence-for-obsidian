import type { AppError } from '../util/errors';
import {
  resolveConflict,
  type ConflictDecision,
  type ConflictDeps,
  type ConflictOutcome,
} from './conflict-executor';
import type { LocalPage } from './pull-planner';
import { describeConflict, type PageConflict } from './push-executor';
import type { PageState } from './sync-state';
import type { SyncFailure } from './sync-types';

/**
 * The conflict step of a sync (spec §6.6.2 step 5).
 *
 * The spec is specific about *when* this runs: **before any write**. A user who
 * chooses "Keep Remote" is choosing to discard local edits, and being asked that
 * after the sync has already started rewriting notes would make the question
 * meaningless.
 *
 * A sync knows a page is conflicted from versions and hashes alone (§6.6.3). What
 * it does not have is the two bodies, which is what FR-6.3 needs to show a diff —
 * so each conflict costs one page fetch. Conflicts are rare and the alternative is
 * asking the user to choose blind.
 */

export interface ConflictPhaseResult {
  /** What the user chose, and what came of it. */
  readonly outcomes: readonly ConflictOutcome[];
  /** Conflicts that could not even be described, so nothing was asked about them. */
  readonly failures: readonly SyncFailure[];
}

export interface ConflictPhaseInput {
  /** Pages the plan classified as conflicted (FR-6.1). */
  readonly conflicts: readonly LocalPage[];
  /** The index, for the record behind each conflicted page. */
  readonly pages: Readonly<Record<string, PageState>>;
  readonly spaceKey: string;
  /** How to put the question. Absent means it cannot be put, so nothing is done. */
  readonly resolve:
    ((conflicts: readonly PageConflict[]) => Promise<readonly ConflictDecision[]>) | undefined;
}

/**
 * The whole step as a sync sees it (spec §6.6.2 step 5).
 *
 * Does nothing at all when there is no way to ask: the conflicts are still
 * reported, and a sync that cannot put the question to a user must not answer it
 * on their behalf.
 */
export async function conflictPhase(
  deps: ConflictDeps,
  input: ConflictPhaseInput,
): Promise<ConflictPhaseResult> {
  const { resolve } = input;
  if (input.conflicts.length === 0 || resolve === undefined) {
    return { outcomes: [], failures: [] };
  }

  const states = input.conflicts.flatMap((page) => {
    const state = input.pages[page.pageId];
    return state === undefined ? [] : [state];
  });

  return runConflictPhase(deps, states, input.spaceKey, resolve);
}

/** Asks about every conflict at once and applies the answers (FR-6.2, FR-6.5). */
export async function runConflictPhase(
  deps: ConflictDeps,
  states: readonly PageState[],
  spaceKey: string,
  resolve: (conflicts: readonly PageConflict[]) => Promise<readonly ConflictDecision[]>,
): Promise<ConflictPhaseResult> {
  const described: PageConflict[] = [];
  const failures: SyncFailure[] = [];
  const byId = new Map(states.map((state) => [state.pageId, state]));

  for (const state of states) {
    const conflict = await describeConflict(deps.push, { state, spaceKey });
    if (conflict.ok) described.push(conflict.value);
    else failures.push(failureOf(state, conflict.error));
  }

  if (described.length === 0) return { outcomes: [], failures };

  const outcomes: ConflictOutcome[] = [];
  for (const decision of await resolve(described)) {
    const state = byId.get(decision.conflict.pageId);
    // A decision for a page this phase did not raise is ignored rather than acted
    // on: the only source is the modal, and acting on an id it invented would
    // write to a page nobody looked at.
    if (state === undefined) continue;
    outcomes.push(await resolveConflict(deps, decision, state, spaceKey));
  }

  return { outcomes, failures };
}

function failureOf(state: PageState, error: AppError): SyncFailure {
  return { pageId: state.pageId, title: state.title, error };
}
