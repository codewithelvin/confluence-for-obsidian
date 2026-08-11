import type { PullItem, PullPlan } from './pull-planner';
import type { StructurePlan } from './structure-planner';
import type { ScannedNote } from '../vault/vault-gateway';

/**
 * Choosing where each pull writes (spec §6.6.2 step 4, FR-7.5).
 *
 * Its own module because it is the one place the two plans have to agree. The pull
 * planner derives a path from the *remote* tree; the structure planner reads what the
 * user did to the vault. When they disagree the file's current location wins, and
 * getting that backwards writes a second note for one page.
 */

export interface RetargetInput {
  readonly pull: readonly PullItem[];
  /** Remote-driven moves this sync will carry out *before* the pull. */
  readonly relocate: readonly { readonly pageId: string }[];
  readonly suppressRelocate: ReadonlySet<string>;
  readonly local: readonly ScannedNote[];
}

/**
 * Redirects each pull to where the note actually is.
 *
 * The path a pull derives comes from the *remote* tree, so for a page the user has
 * renamed or moved locally it names the old location — and writing there would
 * create a **second note for the same page**, which the next sync would see as two
 * files claiming one identity. The file's current location wins.
 *
 * A page this sync is relocating is left alone: the relocate runs first and puts the
 * file exactly where the pull expects it, so the scanned path is the stale one there.
 * A relocate the structure planner suppressed does *not* run, so those pages are
 * redirected like any other.
 */
export function retargetPulls(input: RetargetInput): readonly PullItem[] {
  const moving = new Set(
    input.relocate
      .filter((item) => !input.suppressRelocate.has(item.pageId))
      .map((item) => item.pageId),
  );
  const scanned = new Map(
    input.local.flatMap((note) =>
      note.isConflictCopy || note.identity === null ? [] : [[note.identity.id, note.path] as const],
    ),
  );

  return input.pull.map((item) => {
    const here = scanned.get(item.page.id);
    if (here === undefined || here === item.path || moving.has(item.page.id)) return item;
    return { ...item, path: here };
  });
}

/**
 * Everything one sync decided before it started writing.
 *
 * The two plans and the scan they were both read from travel together, because the
 * pull's target for a page depends on what the structure plan found (§6.6.2 step 4):
 * a note the user moved is pulled where it now is, not where the remote tree says.
 */
export interface SyncWork {
  readonly plan: PullPlan;
  readonly structure: StructurePlan;
  readonly scanned: readonly ScannedNote[];
}

export function pullTargets(work: SyncWork): readonly PullItem[] {
  return retargetPulls({
    pull: work.plan.pull,
    relocate: work.plan.relocate,
    suppressRelocate: work.structure.suppressRelocate,
    local: work.scanned,
  });
}
