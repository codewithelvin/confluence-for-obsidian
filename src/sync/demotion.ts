import type { Subscription } from '../settings/settings-types';
import type { Logger } from '../util/logger';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import type { PageState, SyncStateStore } from './sync-state';

/**
 * Demotion — the `Tidy folder notes` command (spec §6.5.4).
 *
 * Promotion is automatic: a leaf that gains its first child becomes `Page/Page.md`
 * the moment the child needs somewhere to go. Demotion deliberately is not. A page
 * that loses its last child keeps its folder, because a subtree that reshaped itself
 * on every child added and removed would move files under the user twice for one
 * edit, and every move rewrites wikilinks vault-wide (D9, risk R3).
 *
 * So the folders accumulate, and this is what clears them — in bulk, when the user
 * asks, and never as a side effect of a sync.
 *
 * Three things stop a demotion, and each is reported rather than worked around:
 * the folder still holds something else, a note already occupies the path, or the
 * page is the one that collapses into the mount (D13), whose folder is the user's.
 */

/** One folder note to be moved back out of its folder. */
export interface DemotionOp {
  readonly pageId: string;
  readonly title: string;
  /** Where the note is now — `Parent/Page/Page.md`. */
  readonly from: string;
  /** Where it goes — `Parent/Page.md`. */
  readonly to: string;
  /** The folder left behind, removed only if the move empties it. */
  readonly folder: string;
}

/** A folder note that could have been demoted but was not, and why. */
export interface RejectedDemotion {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  readonly reason: string;
}

export interface TidyPlan {
  readonly ops: readonly DemotionOp[];
  readonly rejected: readonly RejectedDemotion[];
}

export const EMPTY_TIDY: TidyPlan = { ops: [], rejected: [] };

export interface TidyDeps {
  readonly vault: Pick<VaultGateway, 'move' | 'removeEmptyFolder' | 'folderEntries' | 'exists'>;
  readonly state: SyncStateStore;
  readonly logger: Logger;
  /** Persists the demoted page's record, which the caller owns. */
  readonly record: (subscriptionId: string, page: PageState) => Promise<void>;
}

/** A note's title, as its file name states it. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/**
 * Every folder note in a subscription that no longer needs its folder.
 *
 * Childlessness is read from the **index**, not from the vault: the index is what
 * the last sync saw in Confluence, and a page's children are pages, not files. A
 * folder that happens to look empty may still be the home of a child whose note has
 * not been pulled yet.
 */
export function planDemotions(deps: TidyDeps, subscription: Subscription): TidyPlan {
  const pages = Object.values(deps.state.forSubscription(subscription.id).pages);
  const parents = new Set(pages.map((page) => page.parentId));

  const ops: DemotionOp[] = [];
  const rejected: RejectedDemotion[] = [];

  // Sorted by path so the preview reads in vault order and is the same on every run.
  for (const page of [...pages].sort((a, b) => (a.localPath < b.localPath ? -1 : 1))) {
    if (!page.isFolderNote || parents.has(page.pageId)) continue;

    const folder = parentPath(page.localPath);
    // The root page's folder *is* the mount (D13). Its name belongs to the user, and
    // demoting it would move the mirror's own root note out of the mirror.
    if (page.pageId === subscription.rootPageId || folder === subscription.mountPath) continue;

    const refusal = refuse(deps, page, folder);
    if (refusal !== null) {
      rejected.push({
        pageId: page.pageId,
        title: page.title,
        path: page.localPath,
        reason: refusal,
      });
      continue;
    }

    ops.push({
      pageId: page.pageId,
      title: page.title,
      from: page.localPath,
      to: `${parentPath(folder)}/${nameOf(page.localPath)}.md`,
      folder,
    });
  }

  return { ops, rejected };
}

/** Why this folder note must keep its folder, or `null` if it need not. */
function refuse(deps: TidyDeps, page: PageState, folder: string): string | null {
  const entries = deps.vault.folderEntries(folder);
  const others = entries.filter((entry) => entry !== page.localPath);
  if (others.length > 0) {
    return (
      `its folder still holds ${String(others.length)} other item(s), which would be left in a ` +
      'folder no Confluence page owns. Move them out first.'
    );
  }

  const target = `${parentPath(folder)}/${nameOf(page.localPath)}.md`;
  if (deps.vault.exists(target)) {
    return `"${target}" already exists, so there is nowhere to move the note to.`;
  }
  return null;
}

export interface TidyOutcome {
  readonly demoted: readonly DemotionOp[];
  readonly failures: readonly RejectedDemotion[];
}

/**
 * Carries out the demotions the user confirmed.
 *
 * Through `move`, which is `fileManager.renameFile` — so every wikilink pointing at
 * the note, the user's own included, is rewritten by Obsidian rather than broken
 * (§6.3 rule 2, risk R3). One failure does not stop the rest: these are independent
 * single-file moves, and stopping at the first would leave the user with a half-tidied
 * mirror and no list of what remained.
 */
export async function applyDemotions(
  deps: TidyDeps,
  subscription: Subscription,
  ops: readonly DemotionOp[],
): Promise<TidyOutcome> {
  const demoted: DemotionOp[] = [];
  const failures: RejectedDemotion[] = [];

  for (const op of ops) {
    const moved = await deps.vault.move(op.from, op.to);
    if (!moved.ok) {
      failures.push({
        pageId: op.pageId,
        title: op.title,
        path: op.from,
        reason: moved.error.userMessage,
      });
      continue;
    }

    // Only if the move emptied it. A file that appeared between the plan and the
    // apply keeps its folder rather than being trashed with it.
    await deps.vault.removeEmptyFolder(op.folder);

    const page = deps.state.forSubscription(subscription.id).pages[op.pageId];
    if (page !== undefined) {
      await deps.record(subscription.id, { ...page, localPath: op.to, isFolderNote: false });
    }
    demoted.push(op);
  }

  deps.logger.debug(
    `Tidied ${String(demoted.length)} folder note(s) in ${subscription.mountPath}.`,
  );
  return { demoted, failures };
}

/** One line per demotion, for the preview. */
export function describeDemotion(op: DemotionOp): string {
  return `move out of "${nameOf(op.folder)}/" — the page has no children`;
}
