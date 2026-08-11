import { applyStructure, type StructureDeps, type StructureOutcome } from './structure-executor';
import type { StructureOp, StructurePlan } from './structure-planner';
import type { PageState } from './sync-state';

/**
 * The structure step of a sync (spec §6.6.2 step 6c, FR-7.8).
 *
 * Separate from the engine for the same reason `conflict-phase` is: the engine reads
 * as §6.6.2's algorithm, and the question *"may I reorganise a corporate wiki?"* has
 * enough shape of its own to deserve a file.
 *
 * A sync that cannot ask does not act. That is the same rule conflicts and deletions
 * follow, and it matters most here: `ops` is a list of changes to somebody else's
 * documentation, and FR-7.8 requires them previewed and confirmed. No callback means
 * the plan is reported and nothing is sent.
 */

export interface StructurePhaseInput {
  readonly plan: StructurePlan;
  /** The freshest index records, including anything this sync has already pulled. */
  readonly pages: Readonly<Record<string, PageState>>;
  readonly confirm: ((ops: readonly StructureOp[]) => Promise<boolean>) | undefined;
}

export interface StructurePhaseResult extends StructureOutcome {
  /** What was actually carried out, for the report. */
  readonly ops: readonly StructureOp[];
  /**
   * The user was asked and said no, or there was nobody to ask.
   *
   * Reported rather than inferred from `applied === 0`, which a failure would also
   * produce: "you declined" and "it did not work" are different things to be told.
   */
  readonly declined: boolean;
}

const NOTHING: StructurePhaseResult = {
  states: [],
  applied: 0,
  failures: [],
  ops: [],
  declined: false,
};

export async function structurePhase(
  deps: StructureDeps,
  input: StructurePhaseInput,
): Promise<StructurePhaseResult> {
  const { ops } = input.plan;
  if (ops.length === 0) return NOTHING;

  const confirmed = (await input.confirm?.(ops)) ?? false;
  if (!confirmed) {
    deps.logger.debug(`Structure: ${String(ops.length)} change(s) left unapplied.`);
    // The ops travel with the refusal: the report has to be able to say *what* was
    // not applied, or the user is told a number and left to guess.
    return { ...NOTHING, ops, declined: true };
  }

  const outcome = await applyStructure(deps, ops, input.pages);
  return { ...outcome, ops, declined: false };
}
