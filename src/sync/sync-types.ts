/**
 * Sync orchestration types (spec §6.6.2, FR-3.4, FR-3.9, FR-10.2).
 *
 * Types only — no runtime code, so this module is excluded from coverage gates.
 */

import type { AppError } from '../util/errors';
import type { SkippedAttachment } from './attachment-executor';
import type { ConflictDecision, ConflictOutcome } from './conflict-executor';
import type { MisplacedNote } from './orphans';
import type { LocalPage } from './pull-planner';
import type { PageConflict } from './push-executor';
import type { RejectedStructure, StructureOp } from './structure-planner';
import type { UnmappablePage } from '../vault/path-mapper';

/** Coarse phase, for a progress message the user can read at a glance. */
export type SyncPhase = 'preflight' | 'discovering' | 'scanning' | 'planning' | 'applying';

export interface SyncProgress {
  readonly phase: SyncPhase;
  readonly done: number;
  /** `null` while the total is still unknown, e.g. mid-enumeration. */
  readonly total: number | null;
  readonly detail: string;
}

/** One page that failed, leaving the rest of the sync to continue (FR-3.9). */
export interface SyncFailure {
  readonly pageId: string;
  readonly title: string;
  readonly error: AppError;
}

export interface SyncReport {
  readonly subscriptionId: string;
  readonly pulled: number;
  readonly relocated: number;
  readonly deleted: number;
  readonly unchanged: number;
  /** Pages written but not certified: readable, and permanently read-only (FR-4.4). */
  readonly degraded: readonly LocalPage[];
  /** Changed on both sides, as detected (FR-6.1) — before anything was resolved. */
  readonly conflicts: readonly LocalPage[];
  /** What the user chose for each of them, and what came of it (FR-6.2, FR-6.4). */
  readonly conflictsResolved: readonly ConflictOutcome[];
  readonly localEdits: readonly LocalPage[];
  /** Tracked notes that are gone. The page is untouched (D6, FR-7.4). */
  readonly orphans: readonly LocalPage[];
  /** Tracked notes found outside the mount: reported, never synced (FR-7.7). */
  readonly misplaced: readonly MisplacedNote[];
  /** Local moves and renames carried out in Confluence (FR-7.5, FR-7.6). */
  readonly structural: readonly StructureOp[];
  /** Structural changes the user was asked about and declined (FR-7.8). */
  readonly structuralDeclined: readonly StructureOp[];
  /** Structural changes that cannot be carried out, with the reason (FR-7.7–7.9). */
  readonly structuralRejected: readonly RejectedStructure[];
  readonly untracked: readonly string[];
  readonly truncated: readonly LocalPage[];
  /** Attachments fetched this sync (spec FR-8.1). */
  readonly attachmentsDownloaded: number;
  /** Attachments deliberately not fetched, with the reason (FR-8.4). */
  readonly skippedAttachments: readonly SkippedAttachment[];
  /** Comments pulled into managed regions (spec FR-9.3). */
  readonly commentsPulled: number;
  /** Notes that now carry a comments region. */
  readonly commentRegions: number;
  readonly unmappable: readonly UnmappablePage[];
  readonly failures: readonly SyncFailure[];
  readonly cancelled: boolean;
  readonly finishedAt: string;
}

export interface SyncCallbacks {
  readonly onProgress?: (progress: SyncProgress) => void;
  /** Polled between pages; cancellation leaves the vault consistent (FR-3.4). */
  readonly isCancelled?: () => boolean;
  /**
   * Asked before anything is removed locally (FR-3.5).
   *
   * Defaults to refusing: a sync that cannot ask must not delete.
   */
  readonly confirmDeletions?: (pages: readonly LocalPage[]) => Promise<boolean>;
  /**
   * Asked about every conflict at once, before any write (FR-6.2, FR-6.5, §6.6.2
   * step 5).
   *
   * Absent means the conflicts are only reported: a sync that cannot ask must not
   * choose, and leaving both copies alone is the only answer that loses nothing.
   * Returning a shorter list than it was given is how the user skips one.
   */
  readonly resolveConflicts?: (
    conflicts: readonly PageConflict[],
  ) => Promise<readonly ConflictDecision[]>;
  /**
   * Shown the local moves and renames a sync found, before any of them is sent
   * (FR-7.8, §6.6.2 step 6c).
   *
   * Absent means "cannot ask", and the answer is then no: these are changes to
   * somebody else's documentation, and a sync that reorganises a corporate wiki
   * without being asked is exactly what FR-7.8 exists to prevent.
   */
  readonly confirmStructure?: (ops: readonly StructureOp[]) => Promise<boolean>;
}
