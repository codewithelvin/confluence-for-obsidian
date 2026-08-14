import { describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
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

  it('draws a row for every setting the shared table names', () => {
    // The tab holds no name of its own, so this is what catches a setting
    // added to the table and never rendered.
    const { tab } = setup();
    tab.display();
    const drawn = Array.from(tab.containerEl.querySelectorAll('.setting-item')).map(
      (row) => row.textContent ?? '',
    );

    for (const group of SCALAR_SETTING_GROUPS) {
      expect(drawn.some((text) => text.includes(group.heading))).toBe(true);
      for (const setting of group.settings) {
        expect(drawn.some((text) => text.includes(setting.name))).toBe(true);
      }
    }
  });

  it('redraws through refresh() without duplicating the sections', () => {
    const { tab } = setup();
    tab.refresh();
    const first = tab.containerEl.querySelectorAll('.setting-item-heading').length;

    tab.refresh();

    expect(tab.containerEl.querySelectorAll('.setting-item-heading')).toHaveLength(first);
    expect(checkboxes(tab)).toHaveLength(3);
  });
});
