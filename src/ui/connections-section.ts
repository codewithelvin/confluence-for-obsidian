import { Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { ConfluenceClient } from '../api/confluence-client';
import type { CredentialStore } from '../auth/credential-store';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile } from '../settings/settings-types';
import { ConfirmModal } from './confirm-modal';
import { ConnectionModal, type ConnectionDraft } from './connection-modal';
import { SpaceBrowserModal } from './space-browser-modal';

export interface ConnectionsSectionDeps {
  readonly app: App;
  readonly store: SettingsStore;
  readonly credentials: CredentialStore;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceClient;
  readonly newId: () => string;
  /** Re-renders the owning settings tab after a change. */
  readonly refresh: () => void;
}

/**
 * Connection management (spec FR-1.1 to FR-1.9, FR-2.1).
 *
 * Presentation and orchestration of user intent only — no business logic
 * (spec §7.5). Tokens pass straight to the credential store and are never held
 * here.
 */
export class ConnectionsSection {
  constructor(private readonly deps: ConnectionsSectionDeps) {}

  render(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Connections').setHeading();
    this.renderBody(containerEl);
  }

  /**
   * Everything below the heading. Split out because the declarative settings
   * path supplies the heading itself, as the row it created for this section.
   */
  renderBody(containerEl: HTMLElement): void {
    const { connections } = this.deps.store.get();
    if (connections.length === 0) {
      containerEl.createDiv({
        cls: 'confluence-connection-status',
        text: 'No connections yet. Add your Confluence Data Center site to get started.',
      });
    }

    for (const connection of connections) {
      this.renderConnection(containerEl, connection);
    }

    if (!this.deps.credentials.persistenceAvailable) {
      containerEl.createDiv({
        cls: 'confluence-connection-status is-error',
        text:
          'The operating system keychain is unavailable, so tokens cannot be stored securely ' +
          'and must be re-entered after each restart. They are never written to disk in plain text.',
      });
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('Add connection')
        .setCta()
        .onClick(() => {
          this.openConnectionModal(null);
        }),
    );
  }

  private renderConnection(containerEl: HTMLElement, connection: ConnectionProfile): void {
    const hasToken = this.deps.credentials.has(connection.id);

    new Setting(containerEl)
      .setName(connection.displayName)
      .setDesc(`${connection.baseUrl}${hasToken ? '' : ' — no token stored'}`)
      .addButton((button) =>
        button.setButtonText('Test').onClick(() => {
          void this.testConnection(connection);
        }),
      )
      .addButton((button) =>
        button.setButtonText('Spaces').onClick(() => {
          void this.browseSpaces(connection);
        }),
      )
      .addButton((button) =>
        button.setButtonText('Edit').onClick(() => {
          this.openConnectionModal(connection);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.confirmRemove(connection);
          }),
      );
  }

  private openConnectionModal(existing: ConnectionProfile | null): void {
    const initial =
      existing === null
        ? {}
        : {
            displayName: existing.displayName,
            baseUrl: existing.baseUrl,
            hasStoredToken: this.deps.credentials.has(existing.id),
            strictMarkup: existing.strictMarkup,
          };

    new ConnectionModal(this.deps.app, initial, (draft) => {
      void this.saveConnection(existing, draft);
    }).open();
  }

  private async saveConnection(
    existing: ConnectionProfile | null,
    draft: ConnectionDraft,
  ): Promise<void> {
    const id = existing?.id ?? this.deps.newId();
    const profile: ConnectionProfile = {
      id,
      displayName: draft.displayName,
      baseUrl: draft.baseUrl,
      strictMarkup: draft.strictMarkup,
    };

    const current = this.deps.store.get().connections;
    const connections =
      existing === null
        ? [...current, profile]
        : current.map((item) => (item.id === id ? profile : item));

    await this.deps.store.update({ connections });

    if (draft.token.length > 0) {
      const stored = await this.deps.credentials.set(id, draft.token);
      if (!stored.ok) new Notice(stored.error.userMessage);
    }

    this.deps.refresh();
  }

  private confirmRemove(connection: ConnectionProfile): void {
    const dependents = this.deps.store
      .get()
      .subscriptions.filter((subscription) => subscription.connectionId === connection.id);

    if (dependents.length > 0) {
      new Notice(
        `Remove the ${String(dependents.length)} subscription(s) using "${connection.displayName}" first.`,
      );
      return;
    }

    new ConfirmModal(
      this.deps.app,
      {
        title: 'Remove connection',
        body: `Remove "${connection.displayName}" and its stored token? Nothing in Confluence is changed.`,
        confirmText: 'Remove',
        destructive: true,
      },
      () => {
        void this.removeConnection(connection);
      },
    ).open();
  }

  private async removeConnection(connection: ConnectionProfile): Promise<void> {
    await this.deps.credentials.clear(connection.id);
    await this.deps.store.update({
      connections: this.deps.store.get().connections.filter((item) => item.id !== connection.id),
    });
    this.deps.refresh();
  }

  private async testConnection(connection: ConnectionProfile): Promise<void> {
    new Notice(`Testing "${connection.displayName}"…`);
    const result = await this.deps.createClient(connection).checkConnection();

    if (!result.ok) {
      new Notice(result.error.userMessage, 10_000);
      return;
    }

    const { user, version, versionSupported } = result.value;
    if (!versionSupported) {
      new Notice(
        `Connected as ${user.displayName}, but Confluence ${version?.raw ?? 'unknown'} is too old. ` +
          'Personal Access Tokens require Confluence 7.9 or later.',
        10_000,
      );
      return;
    }

    new Notice(
      `Connected as ${user.displayName} (Confluence ${version?.raw ?? 'version unknown'}).`,
      6000,
    );
  }

  private async browseSpaces(connection: ConnectionProfile): Promise<void> {
    new Notice('Loading spaces…');
    const result = await this.deps.createClient(connection).listSpaces();

    if (!result.ok) {
      new Notice(result.error.userMessage, 10_000);
      return;
    }
    if (result.value.length === 0) {
      new Notice('No spaces are visible to this account.');
      return;
    }

    new SpaceBrowserModal(this.deps.app, result.value, (space) => {
      // Subscriptions arrive in M3; until then, selecting reports the choice.
      new Notice(`Selected ${space.name} (${space.key}).`);
    }).open();
  }
}
