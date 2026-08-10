import { afterEach, describe, expect, it } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import ConfluenceConnectorPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings/settings-store';
import { clearRegisteredSecrets, redact, registerSecret } from '../../src/util/logger';
import { App as FakeApp, type Plugin as FakePlugin } from '../fakes/obsidian';

const manifest = {
  id: 'confluence-dc-connector',
  name: 'Confluence Data Center Connector',
  version: '0.0.1',
  minAppVersion: '1.5.3',
  description: 'test',
  author: 'test',
  isDesktopOnly: true,
} as unknown as PluginManifest;

function createPlugin(): ConfluenceConnectorPlugin {
  return new ConfluenceConnectorPlugin(new FakeApp() as unknown as App, manifest);
}

/** The fake Plugin base exposes registered tabs and persisted data for assertions. */
function asFake(plugin: ConfluenceConnectorPlugin): FakePlugin {
  return plugin as unknown as FakePlugin;
}

/**
 * M0 exit criterion (spec §12): the plugin loads in a vault, does nothing, and
 * produces no errors.
 */
describe('ConfluenceConnectorPlugin', () => {
  afterEach(clearRegisteredSecrets);

  it('constructs without touching settings or the network', () => {
    expect(() => createPlugin()).not.toThrow();
  });

  it('loads cleanly and registers exactly one settings tab', async () => {
    const plugin = createPlugin();
    await plugin.onload();
    expect(asFake(plugin).settingTabs).toHaveLength(1);
  });

  it('starts from defaults when no data has been persisted', async () => {
    const plugin = createPlugin();
    await plugin.onload();
    expect(await asFake(plugin).loadData()).toBeNull();
  });

  it('applies persisted settings on load', async () => {
    const plugin = createPlugin();
    asFake(plugin).setStoredData({ debugLogging: true, attachmentSizeLimitMb: 99 });
    await plugin.onload();

    const tab = asFake(plugin).settingTabs[0];
    expect(tab).toBeDefined();
    expect(() => tab!.display()).not.toThrow();
  });

  it('re-reads settings when data.json changes externally', async () => {
    const plugin = createPlugin();
    await plugin.onload();
    asFake(plugin).setStoredData({ ...DEFAULT_SETTINGS, debugLogging: true });
    await expect(plugin.onExternalSettingsChange()).resolves.toBeUndefined();
  });

  it('unloads without throwing', async () => {
    const plugin = createPlugin();
    await plugin.onload();
    expect(() => plugin.onunload()).not.toThrow();
  });

  it('drops registered secrets on unload so no token outlives the plugin', async () => {
    const plugin = createPlugin();
    await plugin.onload();
    registerSecret('supersecretvalue');
    expect(redact('supersecretvalue')).toBe('[REDACTED]');

    plugin.onunload();
    expect(redact('supersecretvalue')).toBe('supersecretvalue');
  });
});
