import type { ConfluenceGateway } from '../api/confluence-client';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import type { VaultGateway } from '../vault/vault-gateway';
import { diffLabels, labelsAfter } from './labels';
import type { PageState } from './sync-state';

/**
 * Sending a note's tag changes to Confluence as labels (spec FR-9.2).
 *
 * Kept out of `push-executor` because it answers a different question. That file is
 * the gates: everything in it decides whether anything may leave the machine at
 * all. This runs *after* that decision, cannot reverse it, and cannot fail the push
 * — a label is metadata, and letting one fail the publication of the content it
 * describes would be the wrong way round.
 */

/**
 * What this needs of the push's dependencies, and no more.
 *
 * Declared narrowly rather than importing `PushDeps`, which would make the two
 * modules import each other. `PushDeps` satisfies it structurally.
 */
export interface LabelPushDeps {
  readonly client: Pick<ConfluenceGateway, 'addLabels' | 'removeLabel'>;
  readonly vault: Pick<VaultGateway, 'readTags'>;
  readonly logger: Logger;
}

/** The label set after a push, and anything about it the user has to be told. */
export interface LabelResult {
  readonly labels: readonly string[];
  /**
   * A label call that failed, or a tag Confluence cannot hold.
   *
   * Never a reason to report the push as blocked, and never something to swallow
   * either: FR-9.2 requires an unrepresentable tag to be *reported*.
   */
  readonly warnings: readonly AppError[];
}

/** The message FR-9.2 owes the user about a tag Confluence will not take. */
function unrepresentableWarning(state: PageState, tags: readonly string[]): AppError {
  const named = tags.map((tag) => `"${tag}"`).join(', ');

  return new AppError(
    'LABEL_UNSUPPORTED',
    `Confluence cannot store ${named} as a label on "${state.title}", so ` +
      `${tags.length === 1 ? 'it stays' : 'they stay'} in the note only. A Confluence label ` +
      'may not contain spaces, commas or colons.',
  );
}

async function sendLabels(deps: LabelPushDeps, state: PageState): Promise<LabelResult> {
  const diff = diffLabels(deps.vault.readTags(state.localPath), state.labels);
  const warnings =
    diff.unrepresentable.length === 0 ? [] : [unrepresentableWarning(state, diff.unrepresentable)];

  if (diff.add.length === 0 && diff.remove.length === 0) {
    return { labels: state.labels, warnings };
  }

  const added = await deps.client.addLabels(state.pageId, diff.add);
  if (!added.ok) return { labels: state.labels, warnings: [...warnings, added.error] };

  // Removals are one request each, and a failure part way through stops there: the
  // record then names exactly the labels the page still has, so the next push tries
  // the rest instead of assuming they went.
  const removed: string[] = [];
  for (const label of diff.remove) {
    const result = await deps.client.removeLabel(state.pageId, label);
    if (!result.ok) {
      return {
        labels: labelsAfter(state.labels, { ...diff, remove: removed }),
        warnings: [...warnings, result.error],
      };
    }
    removed.push(label);
  }

  return { labels: labelsAfter(state.labels, diff), warnings };
}

/** Applies the tag changes the user made, and reports what did not go with them. */
export async function applyLabels(deps: LabelPushDeps, state: PageState): Promise<LabelResult> {
  const result = await sendLabels(deps, state);

  // Logged as well as returned. A "Keep Local" conflict resolution reaches
  // `pushPage` through a path whose outcome has nowhere to carry a warning, and a
  // label that did not apply has to leave a trace somewhere.
  for (const warning of result.warnings) deps.logger.warn(warning.userMessage);
  return result;
}
