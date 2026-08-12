import { Notice, TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { SettingsStore } from '../settings/settings-store';
import type { Subscription } from '../settings/settings-types';
import type { PushPrompts, PushReport, PushService } from '../sync/push-service';

/**
 * The two push commands (spec FR-5.1, FR-5.6).
 *
 * Thin dispatch, like every other command (spec §6.1): decide which pages the user
 * meant, hand them to `PushService`, and report what happened. Push is a command
 * and only a command — nothing here is wired to a save, a timer or a file event
 * (FR-5.1).
 */

export interface PushCommandDeps {
  readonly plugin: Plugin;
  readonly store: SettingsStore;
  readonly push: PushService;
  /** Modal-backed answers to verification failures and conflicts. */
  readonly prompts: () => PushPrompts;
}

/**
 * Whether the batch push the user started should stop (FR-10.6).
 *
 * Module state rather than a field on a service, because it is the *command* that is
 * running, not the service: `PushService` is stateless by design and pushing a note
 * from one command while cancelling from another is the same user pressing two keys.
 */
let stopRequested = false;
let pushRunning = false;

export function registerPushCommands(deps: PushCommandDeps): void {
  deps.plugin.addCommand({
    id: 'push-current-page',
    name: 'Push this page to Confluence',
    callback: () => {
      void pushActive(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'push-modified-pages',
    name: 'Push all locally modified pages',
    callback: () => {
      void pushAll(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'stop-push',
    name: 'Stop the push in progress',
    callback: () => {
      stopRequested = pushRunning;
      new Notice(
        pushRunning
          ? 'Stopping after the page being pushed. Pages already published stay published.'
          : 'No push is running.',
      );
    },
  });
}

function activeNote(deps: PushCommandDeps): TFile | null {
  const file = deps.plugin.app.workspace.getActiveFile();
  return file instanceof TFile && file.extension === 'md' ? file : null;
}

async function pushActive(deps: PushCommandDeps): Promise<void> {
  const file = activeNote(deps);
  if (file === null) {
    new Notice('Open a Confluence note first.');
    return;
  }

  const result = await deps.push.pushNote(file.path, deps.prompts());
  if (!result.ok) {
    new Notice(result.error.userMessage, 12_000);
    return;
  }
  announce(result.value, file.basename);
}

async function pushAll(deps: PushCommandDeps): Promise<void> {
  const { subscriptions } = deps.store.get();
  if (subscriptions.length === 0) {
    new Notice('No Confluence subscriptions yet. Add one in the plugin settings.');
    return;
  }
  if (pushRunning) {
    new Notice('A push is already running.');
    return;
  }

  stopRequested = false;
  pushRunning = true;
  // Duration 0 keeps it up for the whole batch; it is the progress indicator
  // FR-10.6 asks for, and `Stop the push in progress` is what cancels it.
  const progress = new Notice('Pushing…', 0);

  try {
    for (const subscription of subscriptions) {
      if (stopRequested) break;
      await pushOne(deps, subscription, progress);
    }
  } finally {
    progress.hide();
    pushRunning = false;
    stopRequested = false;
  }
}

async function pushOne(
  deps: PushCommandDeps,
  subscription: Subscription,
  progress: Notice,
): Promise<void> {
  const result = await deps.push.pushSubscription(subscription, deps.prompts(), {
    onProgress: (done, total) => {
      progress.setMessage(
        `${subscription.spaceKey}: pushing ${String(done + 1)} of ${String(total)}…`,
      );
    },
    isCancelled: () => stopRequested,
  });

  if (!result.ok) {
    new Notice(`${subscription.spaceKey}: ${result.error.userMessage}`, 12_000);
    return;
  }
  announce(result.value, subscription.spaceKey);
}

/**
 * One notice per push, naming what needs attention.
 *
 * A push that changed nothing says so rather than staying silent: after a command
 * that could publish to a corporate wiki, "nothing happened" is information.
 */
function announce(report: PushReport, label: string): void {
  const parts = [`${String(report.pushed.length)} pushed`];
  if (report.skipped > 0) parts.push(`${String(report.skipped)} unchanged`);
  if (report.blocked.length > 0) parts.push(`${String(report.blocked.length)} blocked`);
  // Named separately from `blocked`: these pages *are* published, and a label that
  // did not apply must not read as a page that failed to (FR-9.2).
  if (report.warnings.length > 0) parts.push(`${String(report.warnings.length)} label warning(s)`);

  const resolved = report.conflicts.filter((outcome) => outcome.choice !== 'skip').length;
  if (resolved > 0) parts.push(`${String(resolved)} conflict(s) resolved`);
  if (report.cancelled) parts.push('stopped early');

  const problems = report.blocked.length + report.conflicts.length + report.warnings.length;
  new Notice(
    `${label}: ${parts.join(', ')}` + (problems === 0 ? '.' : ' — see the sync panel for details.'),
    problems === 0 ? 5000 : 12_000,
  );
}
