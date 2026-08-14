import { PluginSettingTab, Setting } from 'obsidian';
import type { Plugin } from 'obsidian';
import { ConnectionsSection, type ConnectionsSectionDeps } from '../ui/connections-section';
import { SubscriptionsSection } from '../ui/subscriptions-section';
import type { SyncController } from '../sync/sync-controller';
import { AppError } from '../util/errors';
import { err } from '../util/result';
import {
  SCALAR_SETTING_GROUPS,
  validateScalarNumber,
  type ScalarSetting,
  type ScalarSettingKey,
} from './scalar-settings';
import type { SettingsStore } from './settings-store';
import type { PluginSettings, Subscription } from './settings-types';

/** Everything the tab needs; `app` and `refresh` are supplied by the tab itself. */
export interface SettingsTabDeps extends Omit<ConnectionsSectionDeps, 'app' | 'refresh'> {
  readonly controller: SyncController;
  readonly startSync: (subscription: Subscription) => void;
}

/**
 * Settings UI. Presentation only — it reads and writes the store and holds no
 * business logic (spec §7.5).
 *
 * Drawn imperatively through `display()`. Obsidian 1.13.0 deprecates that in
 * favour of `getSettingDefinitions()`, which also lists settings in the
 * settings search — but the declarative form describes *rows*, and connections
 * and subscriptions are collections the user adds to and removes from. A
 * `render` definition was tried for them and does not hold: the heading appears
 * and the body does not, because `render` exists to fill one row, not to append
 * a section beside it, and anything put in the group list does not survive the
 * host finalising it. Porting them properly means `SettingDefinitionList` or
 * `SettingDefinitionPage`, which changes what the sections look like — a
 * decision, not a refactor (§16 O23).
 *
 * `SCALAR_SETTING_GROUPS` still names the six scalar settings once, so that
 * port has a single place to read them from when it happens.
 */
export class ConfluenceSettingTab extends PluginSettingTab {
  private readonly store: SettingsStore;
  private readonly connections: ConnectionsSection;
  private readonly subscriptions: SubscriptionsSection;

  constructor(plugin: Plugin, deps: SettingsTabDeps) {
    super(plugin.app, plugin);
    this.store = deps.store;

    const refresh = (): void => {
      this.refresh();
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

  /** Redraws the tab after a connection or subscription changed. */
  refresh(): void {
    this.display();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.connections.render(containerEl);
    this.subscriptions.render(containerEl);

    for (const group of SCALAR_SETTING_GROUPS) {
      new Setting(containerEl).setName(group.heading).setHeading();
      for (const setting of group.settings) {
        this.renderScalar(containerEl, setting);
      }
    }
  }

  private renderScalar(containerEl: HTMLElement, setting: ScalarSetting): void {
    const row = new Setting(containerEl).setName(setting.name).setDesc(setting.desc);
    const current = this.store.get()[setting.key];

    if (setting.kind === 'toggle') {
      row.addToggle((toggle) =>
        toggle.setValue(current === true).onChange((value) => {
          void this.writeScalar(setting.key, value);
        }),
      );
      return;
    }

    row.addText((text) =>
      text.setValue(String(current)).onChange((raw) => {
        const parsed = Number.parseInt(raw, 10);
        // A rejected value is left unwritten rather than corrected: the user is
        // mid-keystroke, and rewriting the field under them loses the caret.
        if (Number.isNaN(parsed)) return;
        if (validateScalarNumber(setting, parsed) !== undefined) return;
        void this.writeScalar(setting.key, parsed);
      }),
    );
  }

  private writeScalar(key: ScalarSettingKey, value: number | boolean): Promise<void> {
    // A computed key cannot be checked against `PluginSettings` by inference;
    // `ScalarSettingKey` has already established that it names one of them.
    const patch = { [key]: value } as Partial<PluginSettings>;
    return this.store.update(patch);
  }
}
