import { describe, expect, it } from 'vitest';
import { Setting } from 'obsidian';
import type {
  Plugin,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  SettingGroup,
} from 'obsidian';
import { SCALAR_SETTING_GROUPS } from '../../src/settings/scalar-settings';
import { ConfluenceSettingTab } from '../../src/settings/settings-tab';
import { SettingsStore } from '../../src/settings/settings-store';
import { CredentialStore } from '../../src/auth/credential-store';
import type { ConfluenceClient } from '../../src/api/confluence-client';
import { Logger } from '../../src/util/logger';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncController } from '../../src/sync/sync-controller';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import { FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';
import { App as FakeApp, Plugin as FakePlugin, type PluginManifest } from '../fakes/obsidian';

const manifest: PluginManifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence DC Connector',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
  isDesktopOnly: true,
};

function setup(): { store: SettingsStore; tab: ConfluenceSettingTab } {
  const plugin = new FakePlugin(new FakeApp(), manifest);
  const logger = new Logger('test', () => false);
  const store = new SettingsStore(plugin, logger);
  const stateGateway = new FakeStateGateway();

  const controller = new SyncController({
    settings: store,
    vault: new FakeVaultGateway(),
    state: new SyncStateStore(stateGateway),
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    suspensions: new SuspensionRegistry(),
    logger,
    newId: () => 'test-subscription-id',
    createClient: () => {
      throw new Error('no client should be created while rendering');
    },
    now: () => '2026-08-10T12:00:00Z',
  });

  const tab = new ConfluenceSettingTab(plugin as unknown as Plugin, {
    store,
    credentials: new CredentialStore(null, store, logger),
    controller,
    createClient: (): ConfluenceClient => {
      throw new Error('no client should be created while rendering');
    },
    startSync: () => {
      throw new Error('no sync should start merely by rendering');
    },
    newId: () => 'test-connection-id',
  });
  return { store, tab };
}

function checkboxes(tab: ConfluenceSettingTab): HTMLInputElement[] {
  return Array.from(tab.containerEl.querySelectorAll('input[type=checkbox]'));
}

function textInputs(tab: ConfluenceSettingTab): HTMLInputElement[] {
  return Array.from(tab.containerEl.querySelectorAll('input[type=text]'));
}

describe('ConfluenceSettingTab', () => {
  it('mounts without throwing', () => {
    const { tab } = setup();
    expect(() => tab.display()).not.toThrow();
  });

  it('renders every setting group as a heading', () => {
    const { tab } = setup();
    tab.display();
    const headings = tab.containerEl.querySelectorAll('.setting-item-heading');
    expect(headings).toHaveLength(5);
  });

  it('creates no Confluence client merely by rendering', () => {
    // Rendering settings must never touch the network; setup() throws if a
    // client is constructed.
    const { tab } = setup();
    expect(() => tab.display()).not.toThrow();
  });

  it('warns when the OS keychain is unavailable', () => {
    const { tab } = setup();
    tab.display();
    const warning = tab.containerEl.querySelector('.confluence-connection-status.is-error');
    expect(warning?.textContent).toContain('keychain is unavailable');
  });

  it('renders all current settings as controls', () => {
    const { tab } = setup();
    tab.display();
    expect(checkboxes(tab)).toHaveLength(3);
    expect(textInputs(tab)).toHaveLength(3);
  });

  it('does not duplicate controls when re-displayed', () => {
    const { tab } = setup();
    tab.display();
    tab.display();
    expect(checkboxes(tab)).toHaveLength(3);
  });

  it('shows the persisted value rather than a hardcoded default', async () => {
    const { store, tab } = setup();
    await store.update({ attachmentSizeLimitMb: 77, debugLogging: true });
    tab.display();
    expect(textInputs(tab)[0]?.value).toBe('77');
    expect(checkboxes(tab)[2]?.checked).toBe(true);
  });

  it('persists a toggled boolean setting', () => {
    const { store, tab } = setup();
    tab.display();

    const debugToggle = checkboxes(tab)[2];
    expect(debugToggle).toBeDefined();
    debugToggle!.checked = true;
    debugToggle!.dispatchEvent(new Event('change'));

    expect(store.get().debugLogging).toBe(true);
  });

  it('persists a valid numeric setting', () => {
    const { store, tab } = setup();
    tab.display();

    const sizeInput = textInputs(tab)[0];
    sizeInput!.value = '50';
    sizeInput!.dispatchEvent(new Event('input'));

    expect(store.get().attachmentSizeLimitMb).toBe(50);
  });

  it('persists the attachment and safety toggles', () => {
    const { store, tab } = setup();
    tab.display();

    const [referencedOnly, forcePush] = checkboxes(tab);
    referencedOnly!.checked = false;
    referencedOnly!.dispatchEvent(new Event('change'));
    forcePush!.checked = true;
    forcePush!.dispatchEvent(new Event('change'));

    expect(store.get().attachmentsReferencedOnly).toBe(false);
    expect(store.get().allowForcePush).toBe(true);
  });

  it('persists the retention and threshold settings', () => {
    const { store, tab } = setup();
    tab.display();

    const [, retention, threshold] = textInputs(tab);
    retention!.value = '30';
    retention!.dispatchEvent(new Event('input'));
    threshold!.value = '2500';
    threshold!.dispatchEvent(new Event('input'));

    expect(store.get().backupRetentionDays).toBe(30);
    expect(store.get().pageCountWarningThreshold).toBe(2500);
  });

  it('ignores invalid input for the retention and threshold settings', () => {
    const { store, tab } = setup();
    tab.display();
    const before = store.get();

    const [, retention, threshold] = textInputs(tab);
    retention!.value = 'soon';
    retention!.dispatchEvent(new Event('input'));
    threshold!.value = '-1';
    threshold!.dispatchEvent(new Event('input'));

    expect(store.get().backupRetentionDays).toBe(before.backupRetentionDays);
    expect(store.get().pageCountWarningThreshold).toBe(before.pageCountWarningThreshold);
  });

  it('ignores invalid numeric input instead of persisting a broken value', () => {
    const { store, tab } = setup();
    tab.display();
    const original = store.get().attachmentSizeLimitMb;

    for (const invalid of ['', 'abc', '0', '-3']) {
      const sizeInput = textInputs(tab)[0];
      sizeInput!.value = invalid;
      sizeInput!.dispatchEvent(new Event('input'));
      expect(store.get().attachmentSizeLimitMb).toBe(original);
    }
  });
});

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
  return 'type' in item && item.type === 'group';
}

function isRender(item: SettingDefinitionItem): item is SettingDefinition {
  return 'render' in item && typeof item.render === 'function';
}

/** Every control the declarative path declares, in order. */
function declaredControls(tab: ConfluenceSettingTab): { key: string; type: string }[] {
  return tab
    .getSettingDefinitions()
    .filter(isGroup)
    .flatMap((group) => group.items ?? [])
    .flatMap((item) =>
      'control' in item && item.control !== undefined
        ? [{ key: item.control.key, type: item.control.type }]
        : [],
    );
}

/**
 * Obsidian 1.13.0 and later render the tab from these instead of calling
 * `display()`, so anything missing here is invisible on a current install.
 * `display()` stays as the pre-1.13 fallback, which is what keeps
 * `minAppVersion` at 1.7.2.
 */
describe('ConfluenceSettingTab declarative definitions', () => {
  it('declares the dynamic sections and one group per scalar heading', () => {
    const { tab } = setup();
    const items = tab.getSettingDefinitions();

    expect(items.filter(isRender).map((item) => item.name)).toEqual([
      'Connections',
      'Subscriptions',
    ]);
    expect(items.filter(isGroup).map((group) => group.heading)).toEqual([
      'Attachments',
      'Safety',
      'Advanced',
    ]);
  });

  it('declares every scalar setting exactly once, with the shared name and description', () => {
    const { tab } = setup();
    const declared = tab
      .getSettingDefinitions()
      .filter(isGroup)
      .flatMap((group) => group.items ?? []);
    const expected = SCALAR_SETTING_GROUPS.flatMap((group) => group.settings);

    expect(declared).toHaveLength(expected.length);
    for (const [index, setting] of expected.entries()) {
      expect(declared[index]?.name).toBe(setting.name);
      expect(declared[index]?.desc).toBe(setting.desc);
    }
  });

  it('declares the same controls the imperative fallback draws', () => {
    // The drift guard. Two renderings of one tab is the standing risk in
    // keeping display(); this fails the moment they disagree.
    const { tab } = setup();
    tab.display();
    const declared = declaredControls(tab);

    expect(declared.filter((control) => control.type === 'toggle')).toHaveLength(
      checkboxes(tab).length,
    );
    expect(declared.filter((control) => control.type === 'number')).toHaveLength(
      textInputs(tab).length,
    );
  });

  it('reads a control value from the store, not a default', async () => {
    const { store, tab } = setup();
    await store.update({ attachmentSizeLimitMb: 77, debugLogging: true });

    expect(tab.getControlValue('attachmentSizeLimitMb')).toBe(77);
    expect(tab.getControlValue('debugLogging')).toBe(true);
  });

  it('returns undefined for a key that is not a setting', () => {
    const { tab } = setup();
    expect(tab.getControlValue('credentials')).toBeUndefined();
    expect(tab.getControlValue('nonsense')).toBeUndefined();
  });

  it('persists a control value', async () => {
    const { store, tab } = setup();

    await tab.setControlValue('backupRetentionDays', 30);
    await tab.setControlValue('allowForcePush', true);

    expect(store.get().backupRetentionDays).toBe(30);
    expect(store.get().allowForcePush).toBe(true);
  });

  it('refuses a value of the wrong type, an out-of-range number, or an unknown key', async () => {
    const { store, tab } = setup();
    const before = store.get();

    await tab.setControlValue('backupRetentionDays', 'thirty');
    await tab.setControlValue('allowForcePush', 'yes');
    await tab.setControlValue('attachmentSizeLimitMb', 0);
    await tab.setControlValue('attachmentSizeLimitMb', 2.5);
    await tab.setControlValue('nonsense', 1);

    expect(store.get().backupRetentionDays).toBe(before.backupRetentionDays);
    expect(store.get().allowForcePush).toBe(before.allowForcePush);
    expect(store.get().attachmentSizeLimitMb).toBe(before.attachmentSizeLimitMb);
  });

  it('rejects a number below its floor through the declared validator', () => {
    const { tab } = setup();
    const sizeLimit = tab
      .getSettingDefinitions()
      .filter(isGroup)
      .flatMap((group) => group.items ?? [])
      .find((item) => 'control' in item && item.control?.key === 'attachmentSizeLimitMb');

    const control =
      sizeLimit !== undefined && 'control' in sizeLimit ? sizeLimit.control : undefined;
    // Narrowed to the number control: across the whole union `validate` takes
    // the intersection of every value type, which is `never`.
    expect(control?.type).toBe('number');
    if (control?.type !== 'number') throw new Error('expected a number control');

    expect(control.validate?.(0)).toBe('Enter 1 or more.');
    expect(control.validate?.(2.5)).toBe('Enter a whole number.');
    expect(control.validate?.(25)).toBeUndefined();
  });

  it('renders a dynamic section into its own body, directly after the heading row', () => {
    const { tab } = setup();
    const connections = tab.getSettingDefinitions().filter(isRender)[0];
    expect(connections).toBeDefined();

    const host = document.createElement('div');
    const setting = new Setting(host);
    connections!.render!(setting, {} as unknown as SettingGroup);

    const body = host.querySelector('.confluence-settings-section');
    expect(body).not.toBeNull();
    // Directly after, so the section cannot drift away from its heading.
    expect(setting.settingEl.nextElementSibling).toBe(body);
    expect(body?.textContent).toContain('No connections yet');
  });

  it('redraws through update() when the host has it, and through display() when it does not', () => {
    // The two are not interchangeable: on 1.13+ the tab is rendered from the
    // definitions, so a display() here would redraw it in the fallback layout
    // and the declarative rendering would not return until the tab reopened.
    const { tab } = setup();
    expect(tab.containerEl.childElementCount).toBe(0);

    tab.refresh();
    expect(tab.containerEl.childElementCount).toBeGreaterThan(0);

    const host = tab as unknown as { update?: () => void };
    let updates = 0;
    host.update = (): void => {
      updates += 1;
    };
    tab.containerEl.empty();

    tab.refresh();
    expect(updates).toBe(1);
    // update() owns the redraw; display() must not also run and empty it.
    expect(tab.containerEl.childElementCount).toBe(0);
  });

  it('creates no Confluence client merely by describing the settings', () => {
    // setup() throws if a client is constructed; describing must stay offline.
    const { tab } = setup();
    expect(() => tab.getSettingDefinitions()).not.toThrow();
  });
});
