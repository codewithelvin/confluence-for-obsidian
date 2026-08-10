import { PluginSettingTab, Setting } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { SettingsStore } from './settings-store';

/**
 * Settings UI. Presentation only — it reads and writes the store and holds no
 * business logic (spec §7.5).
 *
 * Connection and subscription management land in M1 and M3 respectively; this
 * tab exposes exactly the settings that exist today.
 */
export class ConfluenceSettingTab extends PluginSettingTab {
  constructor(
    plugin: Plugin,
    private readonly store: SettingsStore,
  ) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
