import { Notice, TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { ConfluenceClient } from '../api/confluence-client';
import type { CredentialStore } from '../auth/credential-store';
import { probeSpaceFidelity } from '../diagnostics/fidelity-probe';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import type { NoteService } from '../sync/note-service';
import type { SyncController } from '../sync/sync-controller';
import { FidelityReportModal } from '../ui/fidelity-report-modal';
import { SpaceBrowserModal } from '../ui/space-browser-modal';

/**
 * Command registration. Thin dispatch only — no business logic (spec §6.1).
 *
 * No default hotkeys, and no plugin name in any command title: Obsidian adds
 * the prefix itself (spec §7.4).
 */

export interface CommandDeps {
  readonly plugin: Plugin;
  readonly store: SettingsStore;
  readonly credentials: CredentialStore;
  readonly controller: SyncController;
  /** Note-scoped operations: re-pull this page, open it in Confluence (FR-3.8, FR-10.5). */
  readonly notes: NoteService;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceClient;
  readonly startSync: (subscription: Subscription) => void;
  readonly openSyncPanel: () => void;
}

/** Pages sampled per probe. Large enough to be representative, small enough to stay quick. */
const PROBE_LIMIT = 50;

export function registerCommands(deps: CommandDeps): void {
  deps.plugin.addCommand({
    id: 'sync-now',
    name: 'Sync all subscriptions',
    callback: () => {
      void syncAll(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'pull-current-page',
    name: 'Pull this page from Confluence',
    callback: () => {
      void pullActive(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'open-in-confluence',
    name: 'Open this page in Confluence',
    callback: () => {
      openInConfluence(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'open-sync-panel',
    name: 'Open the sync panel',
    callback: deps.openSyncPanel,
  });

  deps.plugin.addCommand({
    id: 'probe-conversion-fidelity',
    name: 'Check conversion fidelity of a space (diagnostic)',
    callback: () => {
      void runFidelityProbe(deps);
    },
  });
}

/** The note the user is looking at, or `null` if it is not a Markdown file. */
function activeNote(deps: CommandDeps): TFile | null {
  const file = deps.plugin.app.workspace.getActiveFile();
  return file instanceof TFile && file.extension === 'md' ? file : null;
}

async function syncAll(deps: CommandDeps): Promise<void> {
  const { subscriptions } = deps.store.get();
  if (subscriptions.length === 0) {
    new Notice('No Confluence subscriptions yet. Add one in the plugin settings.');
    return;
  }

  for (const subscription of subscriptions) {
    deps.startSync(subscription);
    // Started one at a time: the controller refuses a second concurrent sync,
    // and two sharing a mount would each see the other's half-written files.
    await Promise.resolve();
  }
}

async function pullActive(deps: CommandDeps): Promise<void> {
  const file = activeNote(deps);
  if (file === null) {
    new Notice('Open a Confluence note first.');
    return;
  }

  const result = await deps.notes.pullPage(file.path);
  new Notice(
    result.ok ? `Pulled "${result.value.title}" from Confluence.` : result.error.userMessage,
    result.ok ? 4000 : 10_000,
  );
}

function openInConfluence(deps: CommandDeps): void {
  const file = activeNote(deps);
  const url = file === null ? null : deps.notes.pageUrlFor(file.path);

  if (url === null) {
    new Notice('This note has no Confluence page recorded in its frontmatter.');
    return;
  }
  window.open(url, '_blank');
}

/** The first connection that has a usable token. */
function usableConnection(deps: CommandDeps): ConnectionProfile | null {
  return (
    deps.store.get().connections.find((connection) => deps.credentials.has(connection.id)) ?? null
  );
}

async function runFidelityProbe(deps: CommandDeps): Promise<void> {
  const connection = usableConnection(deps);
  if (connection === null) {
    new Notice('Add a Confluence connection with a token first.');
    return;
  }

  const client = deps.createClient(connection);
  const spaces = await client.listSpaces();
  if (!spaces.ok) {
    new Notice(spaces.error.userMessage, 10_000);
    return;
  }

  new SpaceBrowserModal(deps.plugin.app, spaces.value, (space) => {
    void probeSpace(deps, connection, client, space.key);
  }).open();
}

async function probeSpace(
  deps: CommandDeps,
  connection: ConnectionProfile,
  client: ConfluenceClient,
  spaceKey: string,
): Promise<void> {
  const progress = new Notice(`Reading ${spaceKey}…`, 0);

  const report = await probeSpaceFidelity(client, spaceKey, {
    baseUrl: connection.baseUrl,
    limit: PROBE_LIMIT,
    onProgress: (done, total) => {
      progress.setMessage(`Converting ${spaceKey}: ${String(done)} of ${String(total)} pages…`);
    },
  });

  progress.hide();

  if (!report.ok) {
    new Notice(report.error.userMessage, 10_000);
    return;
  }
  if (report.value.sampled === 0) {
    new Notice(`No pages are visible in ${spaceKey}.`);
    return;
  }

  new FidelityReportModal(deps.plugin.app, report.value, connection.baseUrl).open();
}
