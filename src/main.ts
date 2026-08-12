import { Notice, Plugin, editorInfoField, editorLivePreviewField } from 'obsidian';
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
import { registerPushCommands } from './commands/push-commands';
import { registerCommands } from './commands/register-commands';
import { registerStructureCommands } from './commands/structure-commands';
import { SettingsStore } from './settings/settings-store';
import { ConfluenceSettingTab } from './settings/settings-tab';
import type { ConnectionProfile, Subscription } from './settings/settings-types';
import { BackupStore } from './sync/backup-store';
import { FragmentStore } from './sync/fragment-store';
import { NoteService } from './sync/note-service';
import { PageStructureService } from './sync/page-structure-service';
import { PushService, type PushPrompts } from './sync/push-service';
import { SuspensionRegistry } from './sync/suspension';
import { SyncController } from './sync/sync-controller';
import { SyncStateStore } from './sync/sync-state';
import { childPageSource } from './ui/child-pages';
import { inlinePlaceholderExtension } from './ui/live-preview-placeholders';
import { orphanActions, type OrphanActions } from './ui/orphan-actions';
import { PlaceholderLabels } from './ui/placeholder-labels';
import { askAboutConflicts, pushPrompts } from './ui/push-prompts';
import { askAboutDeletions, askAboutStructure } from './ui/sync-prompts';
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
  private readonly push: PushService;
  private readonly pageStructure: PageStructureService;
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
    const now = (): string => new Date().toISOString();
    // One set of gateways, shared: the controller, the note service and the push
    // service must agree about the vault and the index, or a re-pull would see
    // different state from the sync that wrote it.
    const shared = {
      settings: this.settingsStore,
      vault: new ObsidianVaultGateway(app, () =>
        this.settingsStore.get().subscriptions.map((subscription) => subscription.mountPath),
      ),
      state: new SyncStateStore(state),
      fragments: new FragmentStore(state),
      backups: new BackupStore({
        state,
        logger: this.logger.child('backup'),
        retentionDays: () => this.settingsStore.get().backupRetentionDays,
        now,
      }),
      logger: this.logger.child('sync'),
      createClient: (connection: ConnectionProfile) => this.createClient(connection),
      now,
    };

    this.controller = new SyncController({
      ...shared,
      suspensions: this.suspensions,
      newId,
    });
    this.notes = new NoteService(shared);
    this.push = new PushService(shared);
    this.pageStructure = new PageStructureService(shared);
  }

  /** Modal-backed answers to the questions a push has to ask (FR-5.2, FR-5.7, FR-6.2). */
  private prompts(): PushPrompts {
    return pushPrompts({
      app: this.app,
      allowForcePush: () => this.settingsStore.get().allowForcePush,
      pageUrlFor: (notePath) => this.notes.pageUrlFor(notePath),
      openExternal: (url) => {
        window.open(url, '_blank');
      },
    });
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

    this.registerAllCommands();

    this.registerPlaceholders();
    this.startStatusBar();

    if (!this.credentials.persistenceAvailable) {
      this.logger.warn(
        'The OS keychain is unavailable. Tokens will be held in memory only for this session.',
      );
    }

    this.logger.debug('Loaded.');
  }

  /** Every command the plugin adds, in one place (§6.1: thin dispatch only). */
  private registerAllCommands(): void {
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
    registerPushCommands({
      plugin: this,
      store: this.settingsStore,
      push: this.push,
      prompts: () => this.prompts(),
    });
    registerStructureCommands({
      plugin: this,
      store: this.settingsStore,
      pages: this.pageStructure,
      openNote: (path) => {
        void this.app.workspace.openLinkText(path, '', false);
      },
    });
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
      ...this.orphanActions(),
    });
  }

  /** FR-7.4's Restore and Delete, which only the panel can offer. */
  private orphanActions(): OrphanActions {
    return orphanActions({
      app: this.app,
      restore: async (subscription, pageId) => {
        const restored = await this.notes.restoreOrphan(subscription, pageId);
        return {
          ok: restored.ok,
          message: restored.ok ? `Restored "${restored.value.title}".` : restored.error.userMessage,
        };
      },
      remove: async (subscription, pageId) => {
        const deleted = await this.pageStructure.deleteOrphan(subscription, pageId);
        return {
          ok: deleted.ok,
          message: deleted.ok ? 'Deleted the page in Confluence.' : deleted.error.userMessage,
        };
      },
    });
  }

  /** Block widgets and inline pills for preserved content (spec FR-4.5). */
  private registerPlaceholders(): void {
    const labels = new PlaceholderLabels((sourcePath) => this.labelsFor(sourcePath));

    // The Live Preview half of FR-4.5 (D16). Registered before the Reading View
    // half only because it needs the cache the two now share.
    this.registerEditorExtension(
      inlinePlaceholderExtension({
        // The view's own file, not the workspace's active one: a split pane editing
        // a second note must decorate that note's placeholders, not the other's.
        pathFor: (view) => view.state.field(editorInfoField).file?.path ?? null,
        isLivePreview: (view) => view.state.field(editorLivePreviewField),
        labelFor: (notePath, id) => labels.labelFor(notePath, id),
        ensureLabels: (notePath, onReady) => {
          labels.ensure(notePath, onReady);
        },
      }),
    );

    // A pull rewrites the note and its fragment sidecar together, so the labels
    // cached against the old ids have to go with them.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        labels.forget(file.path);
      }),
    );

    registerPlaceholderRenderer({
      register: (language, handler) => {
        // The handler's promise is returned, not dropped: a `children` macro reads
        // the fragment sidecar before it can draw, and Obsidian awaits the result.
        this.registerMarkdownCodeBlockProcessor(language, (source, element, context) =>
          handler(source, element, context.sourcePath),
        );
      },
      registerInline: (handler) => {
        this.registerMarkdownPostProcessor((element, context) =>
          handler(element, context.sourcePath),
        );
      },
      pageUrlFor: (sourcePath) => this.notes.pageUrlFor(sourcePath),
      labelsFor: (sourcePath) => this.labelsFor(sourcePath),
      // Straight from the metadata cache: Obsidian has already parsed the note,
      // and re-reading it here would be a second parse of a file it knows.
      headingsFor: (sourcePath) => this.app.metadataCache.getCache(sourcePath)?.headings ?? [],
      childPagesFor: childPageSource(this.app, this.notes),
      openExternal: (url) => {
        window.open(url, '_blank');
      },
    });
  }

  /** What each preserved fragment in a note stands for, keyed by placeholder id. */
  private async labelsFor(sourcePath: string): Promise<ReadonlyMap<string, string>> {
    const fragments = await this.notes.fragmentsFor(sourcePath);
    return new Map(
      [...fragments.values()].map((fragment) => [
        fragment.id,
        describeConstruct(fragment.name, fragment.type),
      ]),
    );
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
      confirmDeletions: askAboutDeletions(this.app),
      // Asked before the sync writes anything (§6.6.2 step 5, FR-6.2).
      resolveConflicts: askAboutConflicts(this.app),
      // FR-7.8: nothing structural is sent without the user seeing the whole list.
      confirmStructure: askAboutStructure(this.app, subscription.spaceKey),
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
