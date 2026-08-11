import type { ConflictPhaseResult } from './conflict-phase';
import type { OrphanSplit } from './orphans';
import type { PullOutcome } from './pull-executor';
import type { PullPlan } from './pull-planner';
import type { StructurePhaseResult } from './structure-phase';
import type { RejectedStructure } from './structure-planner';
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
  /** What the structure step did, or was declined (FR-7.5, FR-7.6, FR-7.8). */
  readonly structure: StructurePhaseResult;
  /** What it refused to attempt (FR-7.7–7.9). */
  readonly rejected: readonly RejectedStructure[];
  /** Orphans split from notes that merely left the mount (FR-7.4, FR-7.7). */
  readonly orphans: OrphanSplit;
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
    // Split rather than taken from the plan: a note that left the mount is not an
    // orphan, and offering to delete its page would be offering to delete a page the
    // user is still mirroring somewhere else (FR-7.7).
    orphans: input.orphans.orphans,
    misplaced: input.orphans.misplaced,
    structural: input.structure.declined ? [] : input.structure.ops,
    structuralDeclined: input.structure.declined ? input.structure.ops : [],
    structuralRejected: input.rejected,
    untracked: plan.untracked,
    truncated: plan.truncated,
    attachmentsDownloaded: pulled.attachmentsDownloaded,
    skippedAttachments: pulled.skippedAttachments,
    commentsPulled: pulled.commentsPulled,
    commentRegions: pulled.commentRegions,
    unmappable: plan.unmappable,
    failures: input.failures,
    cancelled: input.cancelled,
    finishedAt: input.finishedAt,
  };
}
