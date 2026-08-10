import { PluginSettingTab, Setting } from 'obsidian';
import type { Plugin } from 'obsidian';
import { ConnectionsSection, type ConnectionsSectionDeps } from '../ui/connections-section';
import { SubscriptionsSection } from '../ui/subscriptions-section';
import type { SyncController } from '../sync/sync-controller';
import { AppError } from '../util/errors';
import { err } from '../util/result';
import type { SettingsStore } from './settings-store';
import type { Subscription } from './settings-types';

/** Everything the tab needs; `app` and `refresh` are supplied by the tab itself. */
export interface SettingsTabDeps extends Omit<ConnectionsSectionDeps, 'app' | 'refresh'> {
  readonly controller: SyncController;
  readonly startSync: (subscription: Subscription) => void;
}

/**
 * Settings UI. Presentation only — it reads and writes the store and holds no
 * business logic (spec §7.5).
 */
export class ConfluenceSettingTab extends PluginSettingTab {
  private readonly store: SettingsStore;
  private readonly connections: ConnectionsSection;
  private readonly subscriptions: SubscriptionsSection;

  constructor(plugin: Plugin, deps: SettingsTabDeps) {
    super(plugin.app, plugin);
    this.store = deps.store;

    const refresh = (): void => {
      this.display();
    };
    this.connections = new ConnectionsSection({ ...deps, app: plugin.app, refresh });
    this.subscriptions = new SubscriptionsSection({
      app: plugin.app,
      store: deps.store,
      controller: deps.controller,
      listSpaces: (connectionId) => {
        const connection = deps.store
          .get()
          .connections.find((candidate) => candidate.id === connectionId);
        if (connection === undefined) {
          return Promise.resolve(
            err(new AppError('NOT_FOUND', 'That connection no longer exists.')),
          );
        }
        return deps.createClient(connection).listSpaces();
      },
      startSync: deps.startSync,
      refresh,
    });
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.connections.render(containerEl);
    this.subscriptions.render(containerEl);
    this.renderAttachmentSettings(containerEl);
    this.renderSafetySettings(containerEl);
    this.renderAdvancedSettings(containerEl);
  }

  private renderAttachmentSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Attachments').setHeading();

    new Setting(containerEl)
      .setName('Maximum attachment size (MB)')
      .setDesc('Larger attachments are skipped and replaced with a placeholder link.')
      .addText((text) =>
        text.setValue(String(this.store.get().attachmentSizeLimitMb)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed < 1) return;
          void this.store.update({ attachmentSizeLimitMb: parsed });
        }),
      );

    new Setting(containerEl)
      .setName('Only download referenced attachments')
      .setDesc(
        'Download just the files embedded in the page body. Turn off to mirror every attachment.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.store.get().attachmentsReferencedOnly).onChange((value) => {
          void this.store.update({ attachmentsReferencedOnly: value });
        }),
      );
  }

  private renderSafetySettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Safety').setHeading();

    new Setting(containerEl)
      .setName('Allow force push')
      .setDesc(
        'Permits pushing a page that failed round-trip verification. This can destroy content ' +
          'in Confluence that the plugin could not represent. Each use still requires typed ' +
          'confirmation.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.store.get().allowForcePush).onChange((value) => {
          void this.store.update({ allowForcePush: value });
        }),
      );

    new Setting(containerEl)
      .setName('Backup retention (days)')
      .setDesc('How long to keep the copies written before any destructive local write.')
      .addText((text) =>
        text.setValue(String(this.store.get().backupRetentionDays)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed < 1) return;
          void this.store.update({ backupRetentionDays: parsed });
        }),
      );
  }

  private renderAdvancedSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Large subtree warning threshold')
      .setDesc('Warn before subscribing to a subtree with more pages than this.')
      .addText((text) =>
        text.setValue(String(this.store.get().pageCountWarningThreshold)).onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed < 1) return;
          void this.store.update({ pageCountWarningThreshold: parsed });
        }),
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Write detailed diagnostics to the developer console. Tokens are never logged.')
      .addToggle((toggle) =>
        toggle.setValue(this.store.get().debugLogging).onChange((value) => {
          void this.store.update({ debugLogging: value });
        }),
      );
  }
}
