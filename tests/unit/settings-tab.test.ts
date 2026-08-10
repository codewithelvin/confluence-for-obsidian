import { describe, expect, it } from 'vitest';
import type { Plugin } from 'obsidian';
import { ConfluenceSettingTab } from '../../src/settings/settings-tab';
import { SettingsStore } from '../../src/settings/settings-store';
import { Logger } from '../../src/util/logger';
import { App as FakeApp, Plugin as FakePlugin, type PluginManifest } from '../fakes/obsidian';

const manifest: PluginManifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence 4 Obsidian',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
  isDesktopOnly: true,
};

function setup(): { store: SettingsStore; tab: ConfluenceSettingTab } {
  const plugin = new FakePlugin(new FakeApp(), manifest);
  const store = new SettingsStore(plugin, new Logger('test', () => false));
  const tab = new ConfluenceSettingTab(plugin as unknown as Plugin, store);
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
    expect(headings).toHaveLength(3);
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
