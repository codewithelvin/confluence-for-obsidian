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

  for (const subscription of subscriptions) {
    await pushOne(deps, subscription);
  }
}

async function pushOne(deps: PushCommandDeps, subscription: Subscription): Promise<void> {
  const result = await deps.push.pushSubscription(subscription, deps.prompts());
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

  const resolved = report.conflicts.filter((outcome) => outcome.choice !== 'skip').length;
  if (resolved > 0) parts.push(`${String(resolved)} conflict(s) resolved`);

  const problems = report.blocked.length + report.conflicts.length;
  new Notice(
    `${label}: ${parts.join(', ')}` + (problems === 0 ? '.' : ' — see the sync panel for details.'),
    problems === 0 ? 5000 : 12_000,
  );
}
