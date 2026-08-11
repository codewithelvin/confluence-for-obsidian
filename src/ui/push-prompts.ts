import type { App } from 'obsidian';
import type { ConflictDecision } from '../sync/conflict-executor';
import type { PageConflict } from '../sync/push-executor';
import type { PushPrompts } from '../sync/push-service';
import { ConflictModal } from './conflict-modal';
import { VerificationFailureModal } from './verification-modal';

/**
 * The bridge between the write path and its modals (spec §6.1, §7.5).
 *
 * `PushService` and `SyncEngine` state *what* they need to ask; this is the only
 * place that knows a modal answers it. Both questions become promises, because the
 * orchestration genuinely cannot continue until the user has decided — and because
 * a promise is something a test can satisfy without a DOM.
 */

export interface PushPromptDeps {
  readonly app: App;
  /** Read live, so toggling the setting takes effect without a reload (FR-5.7). */
  readonly allowForcePush: () => boolean;
  readonly pageUrlFor: (notePath: string) => string | null;
  readonly openExternal: (url: string) => void;
}

/** Collects the user's answer to every conflict at once (FR-6.2, FR-6.5). */
export function askAboutConflicts(
  app: App,
): (conflicts: readonly PageConflict[]) => Promise<readonly ConflictDecision[]> {
  return (conflicts) =>
    new Promise((resolve) => {
      new ConflictModal(app, conflicts, resolve).open();
    });
}

export function pushPrompts(deps: PushPromptDeps): PushPrompts {
  return {
    onVerificationFailure: (page, blocked) =>
      new Promise((resolve) => {
        const url = deps.pageUrlFor(page.path);

        new VerificationFailureModal(deps.app, page, blocked, {
          allowForce: deps.allowForcePush(),
          onForce: () => {
            resolve(true);
          },
          // Escape, Cancel and the close button all mean "do not force" — the
          // push is waiting, and only an explicit typed confirmation is a yes.
          onDismiss: () => {
            resolve(false);
          },
          ...(url === null
            ? {}
            : {
                onOpenInConfluence: (): void => {
                  deps.openExternal(url);
                },
              }),
        }).open();
      }),
    onConflicts: askAboutConflicts(deps.app),
  };
}
