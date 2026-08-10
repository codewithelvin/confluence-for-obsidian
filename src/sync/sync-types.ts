/**
 * Sync orchestration types (spec §6.6.2, FR-3.4, FR-3.9, FR-10.2).
 *
 * Types only — no runtime code, so this module is excluded from coverage gates.
 */

import type { AppError } from '../util/errors';
import type { LocalPage } from './pull-planner';
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
  /** Pages written but not certified: readable, and read-only until M5 (FR-4.4). */
  readonly degraded: readonly LocalPage[];
  readonly conflicts: readonly LocalPage[];
  readonly localEdits: readonly LocalPage[];
  readonly orphans: readonly LocalPage[];
  readonly untracked: readonly string[];
  readonly truncated: readonly LocalPage[];
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
}
