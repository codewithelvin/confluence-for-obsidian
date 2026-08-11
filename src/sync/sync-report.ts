import type { ConflictPhaseResult } from './conflict-phase';
import type { PullOutcome } from './pull-executor';
import type { PullPlan } from './pull-planner';
import type { SyncFailure, SyncReport } from './sync-types';

/**
 * Assembling the sync report (spec §6.6.2 step 8, FR-10.2).
 *
 * Pure, and separate from the engine, because the report is a *view*: it says what
 * the sync planned, what it managed, and what it wants a decision about. Keeping
 * it here means the engine reads as the algorithm §6.6.2 describes rather than as
 * that algorithm plus twenty lines of bookkeeping.
 */

export interface ReportInput {
  readonly subscriptionId: string;
  readonly plan: PullPlan;
  readonly conflicts: ConflictPhaseResult;
  readonly relocated: number;
  readonly deleted: number;
  readonly pulled: PullOutcome;
  readonly failures: readonly SyncFailure[];
  readonly cancelled: boolean;
  readonly finishedAt: string;
}

export function buildSyncReport(input: ReportInput): SyncReport {
  const { plan, pulled } = input;

  return {
    subscriptionId: input.subscriptionId,
    pulled: pulled.states.length,
    relocated: input.relocated,
    deleted: input.deleted,
    unchanged: plan.unchanged,
    degraded: pulled.degraded,
    // As *detected* (FR-6.1). What the user then chose about each one is reported
    // beside it rather than folded in, so the panel can distinguish a conflict that
    // was settled from one that is still waiting.
    conflicts: plan.conflicts,
    conflictsResolved: input.conflicts.outcomes,
    localEdits: plan.localEdits,
    orphans: plan.orphans,
    untracked: plan.untracked,
    truncated: plan.truncated,
    attachmentsDownloaded: pulled.attachmentsDownloaded,
    skippedAttachments: pulled.skippedAttachments,
    unmappable: plan.unmappable,
    failures: input.failures,
    cancelled: input.cancelled,
    finishedAt: input.finishedAt,
  };
}
