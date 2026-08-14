import { PluginSettingTab, Setting } from 'obsidian';
import type { Plugin, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { ConnectionsSection, type ConnectionsSectionDeps } from '../ui/connections-section';
import { SubscriptionsSection } from '../ui/subscriptions-section';
import type { SyncController } from '../sync/sync-controller';
import { AppError } from '../util/errors';
import { err } from '../util/result';
import {
  SCALAR_SETTING_GROUPS,
  scalarSettingFor,
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
 * The tab renders two ways. `getSettingDefinitions()` describes the settings to
 * Obsidian 1.13.0 and later, which is what lists them in the settings search;
 * `display()` draws them by hand for anything older, and Obsidian calls it only
 * when the declarative list is empty. Keeping `display()` is what lets
 * `minAppVersion` stay at 1.7.2 — the declarative half is a method the plugin
 * exposes, not an API it calls, so an older build simply never asks for it.
 * Both halves read `SCALAR_SETTING_GROUPS` so neither can drift from the other.
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

  /**
   * Redraws the tab after a connection or subscription changed.
   *
   * On 1.13.0 and later the tab is rendered from `getSettingDefinitions()`, so
   * re-running `display()` here would empty the container and redraw it in the
   * pre-1.13 layout: the sections would still work, but the declarative
   * rendering would not come back until the tab was reopened. `update()` is the
   * declarative equivalent — and it exists only from 1.13.0, so reaching it by
   * feature test rather than calling it outright is what keeps `minAppVersion`
   * at 1.7.2 (D28).
   */
  refresh(): void {
    if (redrawDeclaratively(this)) return;
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

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.sectionDefinition('Connections', (el) => {
        this.connections.renderBody(el);
      }),
      this.sectionDefinition('Subscriptions', (el) => {
        this.subscriptions.renderBody(el);
      }),
      ...SCALAR_SETTING_GROUPS.map((group) => ({
        type: 'group' as const,
        heading: group.heading,
        items: group.settings.map((setting) => controlDefinition(setting)),
      })),
    ];
  }

  /**
   * A section Obsidian cannot describe declaratively — a collection the user
   * adds to and removes from, not a scalar. The row the host built becomes the
   * heading and the existing imperative renderer fills the space beneath it.
   *
   * The body goes into the group's own list, which is the container the API
   * hands over for exactly this, and which the heading row was appended to a
   * moment earlier — so the section lands under its heading as a sibling of it,
   * the same shape `display()` produces. An earlier version instead anchored
   * the body to `settingEl.parentElement`: that is **null** while the host is
   * still building the row, so the body was created inside the heading row,
   * where the heading's own layout hid it, and both sections disappeared from
   * the settings tab.
   */
  private sectionDefinition(
    name: string,
    renderBody: (containerEl: HTMLElement) => void,
  ): SettingDefinition {
    return {
      name,
      render: (setting, group): void => {
        setting.setHeading();
        renderBody(group?.listEl ?? setting.settingEl);
      },
    };
  }

  override getControlValue(key: string): unknown {
    const setting = scalarSettingFor(key);
    return setting === undefined ? undefined : this.store.get()[setting.key];
  }

  override setControlValue(key: string, value: unknown): void | Promise<void> {
    const setting = scalarSettingFor(key);
    if (setting === undefined) return;

    if (setting.kind === 'toggle') {
      if (typeof value !== 'boolean') return;
      return this.writeScalar(setting.key, value);
    }

    if (typeof value !== 'number' || validateScalarNumber(setting, value) !== undefined) return;
    return this.writeScalar(setting.key, value);
  }

  private writeScalar(key: ScalarSettingKey, value: number | boolean): Promise<void> {
    // A computed key cannot be checked against `PluginSettings` by inference;
    // `scalarSettingFor` has already established that it names one of them.
    const patch = { [key]: value } as Partial<PluginSettings>;
    return this.store.update(patch);
  }
}

/**
 * Redraws through `update()` where the host has it, reporting whether it did.
 *
 * Takes the tab as an argument rather than reading `this`: the feature test has
 * to happen on the live object, and assigning `this` to a local is a lint error.
 */
function redrawDeclaratively(tab: { update?: () => void }): boolean {
  if (typeof tab.update !== 'function') return false;
  tab.update();
  return true;
}

function controlDefinition(setting: ScalarSetting): SettingDefinition {
  if (setting.kind === 'toggle') {
    return {
      name: setting.name,
      desc: setting.desc,
      control: { type: 'toggle', key: setting.key },
    };
  }

  return {
    name: setting.name,
    desc: setting.desc,
    control: {
      type: 'number',
      key: setting.key,
      step: 1,
      // Spread rather than assigned: `exactOptionalPropertyTypes` refuses an
      // explicit `undefined` for an optional property.
      ...(setting.min === undefined ? {} : { min: setting.min }),
      validate: (value: number) => validateScalarNumber(setting, value),
    },
  };
}
