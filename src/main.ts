import { Plugin } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import { SettingsStore } from './settings/settings-store';
import { ConfluenceSettingTab } from './settings/settings-tab';
import { Logger, clearRegisteredSecrets } from './util/logger';

/**
 * Plugin entry point. Lifecycle wiring only — no business logic (spec §6.1).
 *
 * `onload` performs no network I/O and must stay within the 100 ms startup
 * budget (spec §7.1).
 */
export default class ConfluenceConnectorPlugin extends Plugin {
  private readonly logger: Logger;
  private readonly settingsStore: SettingsStore;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.logger = new Logger('core', () => this.settingsStore.get().debugLogging);
    this.settingsStore = new SettingsStore(this, this.logger);
  }

  override async onload(): Promise<void> {
    await this.settingsStore.load();
    this.addSettingTab(new ConfluenceSettingTab(this, this.settingsStore));
    this.logger.debug('Loaded.');
  }

  override onunload(): void {
    // Events, intervals and DOM handlers registered through the plugin
    // lifecycle are released by Obsidian. Leaves are deliberately not detached
    // (spec §7.4). Registered secrets are dropped so no token outlives the
    // plugin in memory.
    clearRegisteredSecrets();
  }

  /** Re-reads settings after `data.json` is changed by an external tool. */
  override async onExternalSettingsChange(): Promise<void> {
    await this.settingsStore.reload();
    this.logger.debug('Settings reloaded after external change.');
  }
}
