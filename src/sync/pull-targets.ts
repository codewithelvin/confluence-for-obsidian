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
  /**
   * Remote-driven moves this sync **actually carried out**, not the ones it planned.
   *
   * A planned move is not a guarantee: it can be suppressed because the page changed
   * on both sides, or simply fail. Either way the file is still where it was, and a
   * pull that trusted the plan would write its body somewhere else — which is the
   * second note this module exists to prevent. So the applied list is what arrives
   * here, and the pull is retargeted for everything not in it.
   */
  readonly relocated: readonly { readonly pageId: string }[];
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
 * A page this sync has already relocated is left alone: the move ran first and put the
 * file exactly where the pull expects it, so there the *scanned* path is the stale one.
 */
export function retargetPulls(input: RetargetInput): readonly PullItem[] {
  const moved = new Set(input.relocated.map((item) => item.pageId));
  const scanned = new Map(
    input.local.flatMap((note) =>
      note.isConflictCopy || note.identity === null ? [] : [[note.identity.id, note.path] as const],
    ),
  );

  return input.pull.map((item) => {
    const here = scanned.get(item.page.id);
    if (here === undefined || here === item.path || moved.has(item.page.id)) return item;
    return { ...item, path: here };
  });
}

/**
 * Everything one sync decided before it started writing.
 *
 * The two plans and the scan they were both read from travel together, because they
 * must be answering about one moment (§6.6.2 step 4): a note the user moved is pulled
 * where it now is, not where the remote tree says.
 */
export interface SyncWork {
  readonly plan: PullPlan;
  readonly structure: StructurePlan;
  readonly scanned: readonly ScannedNote[];
}

export function pullTargets(
  work: SyncWork,
  relocated: readonly { readonly pageId: string }[],
): readonly PullItem[] {
  return retargetPulls({ pull: work.plan.pull, relocated, local: work.scanned });
}
