import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { Subscription } from '../settings/settings-types';
import type { LocalPage } from '../sync/pull-planner';
import { ConfirmModal } from './confirm-modal';

/**
 * The two answers to an orphan (spec FR-7.4), as the panel offers them.
 *
 * Assembled here for the same reason `push-prompts` exists: the composition root wires
 * services to modals and should not also *be* the modal logic. Restoring is one call;
 * deleting goes through FR-7.3's typed confirmation, because the page is in a corporate
 * wiki and the note that described it is already gone.
 */

export interface OrphanActionDeps {
  readonly app: App;
  readonly restore: (
    subscription: Subscription,
    pageId: string,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly remove: (
    subscription: Subscription,
    pageId: string,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
}

export interface OrphanActions {
  readonly restoreOrphan: (subscription: Subscription, page: LocalPage) => void;
  readonly deleteOrphan: (subscription: Subscription, page: LocalPage) => void;
}

function report(outcome: { readonly ok: boolean; readonly message: string }): void {
  new Notice(outcome.message, outcome.ok ? 5000 : 12_000);
}

export function orphanActions(deps: OrphanActionDeps): OrphanActions {
  return {
    restoreOrphan: (subscription, page) => {
      void deps.restore(subscription, page.pageId).then(report);
    },

    deleteOrphan: (subscription, page) => {
      new ConfirmModal(
        deps.app,
        {
          title: 'Delete this page in Confluence?',
          body:
            `The note for "${page.title}" is already gone from your vault. This moves the page ` +
            'itself to the Confluence trash, where an administrator can restore it.',
          confirmText: 'Delete in Confluence',
          destructive: true,
          requireTyped: page.title,
        },
        () => {
          void deps.remove(subscription, page.pageId).then(report);
        },
      ).open();
    },
  };
}
