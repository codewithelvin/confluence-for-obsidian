import { Notice } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { ConfluenceClient } from '../api/confluence-client';
import type { CredentialStore } from '../auth/credential-store';
import { probeSpaceFidelity } from '../diagnostics/fidelity-probe';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile } from '../settings/settings-types';
import { FidelityReportModal } from '../ui/fidelity-report-modal';
import { SpaceBrowserModal } from '../ui/space-browser-modal';

/**
 * Command registration. Thin dispatch only — no business logic (spec §6.1).
 */

export interface CommandDeps {
  readonly plugin: Plugin;
  readonly store: SettingsStore;
  readonly credentials: CredentialStore;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceClient;
}

/** Pages sampled per probe. Large enough to be representative, small enough to stay quick. */
const PROBE_LIMIT = 50;

export function registerCommands(deps: CommandDeps): void {
  deps.plugin.addCommand({
    id: 'probe-conversion-fidelity',
    name: 'Check conversion fidelity of a space (diagnostic)',
    callback: () => {
      void runFidelityProbe(deps);
    },
  });
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
