import { Notice, Plugin } from 'obsidian';
import type { App, PluginManifest, WorkspaceLeaf } from 'obsidian';
import { ConfluenceClient } from './api/confluence-client';
import { ObsidianTransport } from './api/http-transport';
import {
  DEFAULT_RETRY,
  MAX_CONCURRENT_REQUESTS,
  Semaphore,
  realScheduler,
} from './api/rate-limiter';
import { CredentialStore, resolveSafeStorage } from './auth/credential-store';
import { registerCommands } from './commands/register-commands';
import { SettingsStore } from './settings/settings-store';
import { ConfluenceSettingTab } from './settings/settings-tab';
import type { ConnectionProfile, Subscription } from './settings/settings-types';
import { FragmentStore } from './sync/fragment-store';
import { NoteService } from './sync/note-service';
import { SuspensionRegistry } from './sync/suspension';
import { SyncController } from './sync/sync-controller';
import { SyncStateStore } from './sync/sync-state';
import { ConfirmModal } from './ui/confirm-modal';
import { describeConstruct, registerPlaceholderRenderer } from './ui/placeholder-renderer';
import { StatusBar } from './ui/status-bar';
import { SYNC_PANEL_VIEW_TYPE, SyncPanelView } from './ui/sync-panel-view';
import { newId } from './util/id';
import { Logger, clearRegisteredSecrets } from './util/logger';
import { ObsidianVaultGateway } from './vault/obsidian-vault-gateway';
import { ObsidianStateGateway } from './vault/state-gateway';

/** Results per API page. Large enough to keep first sync brisk, small enough to stay responsive. */
const PAGE_SIZE = 50;

/**
 * Plugin entry point and composition root. Lifecycle and wiring only — no
 * business logic (spec §6.1).
 *
 * `onload` performs no network I/O and must stay within the 100 ms startup
 * budget (spec §7.1). The sync state index is read lazily for the same reason.
 */
export default class ConfluenceConnectorPlugin extends Plugin {
  private readonly logger: Logger;
  private readonly settingsStore: SettingsStore;
  private readonly credentials: CredentialStore;
  private readonly suspensions = new SuspensionRegistry();
  private readonly controller: SyncController;
  private readonly notes: NoteService;
  private statusBar: StatusBar | null = null;

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

    const state = new ObsidianStateGateway(app, manifest);
    // One set of gateways, shared: the controller and the note service must agree
    // about the vault and the index, or a re-pull would see different state from
    // the sync that wrote it.
    const shared = {
      settings: this.settingsStore,
      vault: new ObsidianVaultGateway(app, () =>
        this.settingsStore.get().subscriptions.map((subscription) => subscription.mountPath),
      ),
      state: new SyncStateStore(state),
      fragments: new FragmentStore(state),
      logger: this.logger.child('sync'),
      createClient: (connection: ConnectionProfile) => this.createClient(connection),
      now: () => new Date().toISOString(),
    };

    this.controller = new SyncController({
      ...shared,
      suspensions: this.suspensions,
      newId,
    });
    this.notes = new NoteService(shared);
  }

  override async onload(): Promise<void> {
    await this.settingsStore.load();
    // A local read of one small JSON file. Nothing here touches the network,
    // which is what the §7.1 startup budget is really about.
    await this.controller.load();

    this.registerView(SYNC_PANEL_VIEW_TYPE, (leaf) => this.createSyncPanel(leaf));
    this.addSettingTab(
      new ConfluenceSettingTab(this, {
        store: this.settingsStore,
        credentials: this.credentials,
        controller: this.controller,
        createClient: (connection) => this.createClient(connection),
        startSync: (subscription) => {
          this.startSync(subscription);
        },
        newId,
      }),
    );

    registerCommands({
      plugin: this,
      store: this.settingsStore,
      credentials: this.credentials,
      controller: this.controller,
      notes: this.notes,
      createClient: (connection) => this.createClient(connection),
      startSync: (subscription) => {
        this.startSync(subscription);
      },
      openSyncPanel: () => {
        void this.revealSyncPanel();
      },
    });

    this.registerPlaceholders();
    this.startStatusBar();

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
    this.statusBar?.stop();
    this.credentials.forgetSession();
    clearRegisteredSecrets();
  }

  /** Re-reads settings after `data.json` is changed by an external tool. */
  override async onExternalSettingsChange(): Promise<void> {
    await this.settingsStore.reload();
    this.logger.debug('Settings reloaded after external change.');
  }

  private createSyncPanel(leaf: WorkspaceLeaf): SyncPanelView {
    return new SyncPanelView(leaf, {
      store: this.settingsStore,
      controller: this.controller,
      suspensions: this.suspensions,
      startSync: (subscription) => {
        this.startSync(subscription);
      },
    });
  }

  /** Block widgets and inline pills for preserved content (spec FR-4.5). */
  private registerPlaceholders(): void {
    registerPlaceholderRenderer({
      register: (language, handler) => {
        this.registerMarkdownCodeBlockProcessor(language, (source, element, context) => {
          handler(source, element, context.sourcePath);
        });
      },
      registerInline: (handler) => {
        this.registerMarkdownPostProcessor((element, context) =>
          handler(element, context.sourcePath),
        );
      },
      pageUrlFor: (sourcePath) => this.notes.pageUrlFor(sourcePath),
      labelsFor: async (sourcePath) => {
        const fragments = await this.notes.fragmentsFor(sourcePath);
        return new Map(
          [...fragments.values()].map((fragment) => [
            fragment.id,
            describeConstruct(fragment.name, fragment.type),
          ]),
        );
      },
      openExternal: (url) => {
        window.open(url, '_blank');
      },
    });
  }

  private startStatusBar(): void {
    this.statusBar = new StatusBar({
      element: this.addStatusBarItem(),
      controller: this.controller,
      suspensions: this.suspensions,
      subscriptionIds: () =>
        this.settingsStore.get().subscriptions.map((subscription) => subscription.id),
      onClick: () => {
        void this.revealSyncPanel();
      },
    });
    this.statusBar.start();
  }

  private async revealSyncPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE)[0];
    if (existing !== undefined) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) return;

    await leaf.setViewState({ type: SYNC_PANEL_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Runs a sync and reports it. The index is loaded here rather than in
   * `onload` so startup stays inside its budget on a large vault.
   */
  private startSync(subscription: Subscription): void {
    void this.runSync(subscription);
  }

  private async runSync(subscription: Subscription): Promise<void> {
    const result = await this.controller.sync(subscription, {
      confirmDeletions: (pages) => this.confirmDeletions(pages.map((page) => page.path)),
    });

    if (!result.ok) {
      new Notice(result.error.userMessage, 15_000);
      return;
    }

    const report = result.value;
    const problems = report.failures.length + report.conflicts.length;
    new Notice(
      `${subscription.spaceKey}: ${String(report.pulled)} pulled, ` +
        `${String(report.unchanged)} unchanged` +
        (problems === 0 ? '.' : `, ${String(problems)} need attention — see the sync panel.`),
      problems === 0 ? 5000 : 12_000,
    );
  }

  private confirmDeletions(paths: readonly string[]): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(
        this.app,
        {
          title: 'Pages deleted in Confluence',
          body:
            `${String(paths.length)} page(s) no longer exist in Confluence. Move their notes to ` +
            `trash?\n\n${paths.slice(0, 20).join('\n')}`,
          confirmText: 'Move to trash',
          destructive: true,
          // Dismissing the prompt means "do not delete" — the safe reading of
          // silence when the alternative is removing the user's files.
          onDismiss: () => {
            resolve(false);
          },
        },
        () => {
          resolve(true);
        },
      ).open();
    });
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
