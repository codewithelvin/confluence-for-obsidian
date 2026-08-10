import { Plugin } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import { ConfluenceClient } from './api/confluence-client';
import { ObsidianTransport } from './api/http-transport';
import {
  DEFAULT_RETRY,
  MAX_CONCURRENT_REQUESTS,
  Semaphore,
  realScheduler,
} from './api/rate-limiter';
import { CredentialStore, resolveSafeStorage } from './auth/credential-store';
import { SettingsStore } from './settings/settings-store';
import { ConfluenceSettingTab } from './settings/settings-tab';
import type { ConnectionProfile } from './settings/settings-types';
import { newId } from './util/id';
import { Logger, clearRegisteredSecrets } from './util/logger';

/** Results per API page. Large enough to keep first sync brisk, small enough to stay responsive. */
const PAGE_SIZE = 50;

/**
 * Plugin entry point and composition root. Lifecycle and wiring only — no
 * business logic (spec §6.1).
 *
 * `onload` performs no network I/O and must stay within the 100 ms startup
 * budget (spec §7.1).
 */
export default class ConfluenceConnectorPlugin extends Plugin {
  private readonly logger: Logger;
  private readonly settingsStore: SettingsStore;
  private readonly credentials: CredentialStore;

  /** Shared so the concurrency cap applies across every connection at once. */
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);
  private readonly transport = new ObsidianTransport();

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.logger = new Logger('core', () => this.settingsStore.get().debugLogging);
    this.settingsStore = new SettingsStore(this, this.logger);
    this.credentials = new CredentialStore(
      resolveSafeStorage(),
      this.settingsStore,
      this.logger.child('auth'),
    );
  }

  override async onload(): Promise<void> {
    await this.settingsStore.load();

    this.addSettingTab(
      new ConfluenceSettingTab(this, {
        store: this.settingsStore,
        credentials: this.credentials,
        createClient: (connection) => this.createClient(connection),
        newId,
      }),
    );

    if (!this.credentials.persistenceAvailable) {
      this.logger.warn(
        'The OS keychain is unavailable. Tokens will be held in memory only for this session.',
      );
    }

    this.logger.debug('Loaded.');
  }

  override onunload(): void {
    // Events, intervals and DOM handlers registered through the plugin
    // lifecycle are released by Obsidian. Leaves are deliberately not detached
    // (spec §7.4). Tokens are dropped so none outlives the plugin in memory.
    this.credentials.forgetSession();
    clearRegisteredSecrets();
  }

  /** Re-reads settings after `data.json` is changed by an external tool. */
  override async onExternalSettingsChange(): Promise<void> {
    await this.settingsStore.reload();
    this.logger.debug('Settings reloaded after external change.');
  }

  private createClient(connection: ConnectionProfile): ConfluenceClient {
    return new ConfluenceClient(connection.baseUrl, () => this.credentials.get(connection.id), {
      transport: this.transport,
      semaphore: this.semaphore,
      scheduler: realScheduler,
      retry: DEFAULT_RETRY,
      logger: this.logger.child('api'),
      pageSize: PAGE_SIZE,
    });
  }
}
