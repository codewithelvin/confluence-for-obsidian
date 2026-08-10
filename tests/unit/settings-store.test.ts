import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  migrateSettings,
  type SettingsPersistence,
} from '../../src/settings/settings-store';
import { Logger } from '../../src/util/logger';

const silentLogger = new Logger('test', () => false);

function fakePersistence(initial: unknown = null): SettingsPersistence & { saved: unknown[] } {
  const saved: unknown[] = [];
  let stored = initial;
  return {
    saved,
    loadData: () => Promise.resolve(stored),
    saveData: (data: unknown) => {
      stored = data;
      saved.push(data);
      return Promise.resolve();
    },
  };
}

const validConnection = {
  id: 'c1',
  displayName: 'Corp Wiki',
  baseUrl: 'https://wiki.corp/confluence',
};
const validSubscription = {
  id: 's1',
  connectionId: 'c1',
  spaceKey: 'ENG',
  rootPageId: '123',
  mountPath: 'Confluence/ENG',
  syncComments: false,
};

describe('migrateSettings', () => {
  it('returns defaults for input that is not an object', () => {
    for (const input of [null, undefined, 'string', 42, true, []]) {
      expect(migrateSettings(input).settings).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('returns defaults with no warnings for an empty object', () => {
    const result = migrateSettings({});
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  it('always stamps the current schema version', () => {
    expect(migrateSettings({ schemaVersion: 99 }).settings.schemaVersion).toBe(
      DEFAULT_SETTINGS.schemaVersion,
    );
  });

  it('keeps valid values', () => {
    const { settings } = migrateSettings({
      attachmentSizeLimitMb: 50,
      attachmentsReferencedOnly: false,
      allowForcePush: true,
      backupRetentionDays: 30,
      pageCountWarningThreshold: 2000,
      debugLogging: true,
    });
    expect(settings.attachmentSizeLimitMb).toBe(50);
    expect(settings.attachmentsReferencedOnly).toBe(false);
    expect(settings.allowForcePush).toBe(true);
    expect(settings.backupRetentionDays).toBe(30);
    expect(settings.pageCountWarningThreshold).toBe(2000);
    expect(settings.debugLogging).toBe(true);
  });

  it('clamps numbers to their permitted range', () => {
    expect(migrateSettings({ attachmentSizeLimitMb: 0 }).settings.attachmentSizeLimitMb).toBe(1);
    expect(migrateSettings({ attachmentSizeLimitMb: 99999 }).settings.attachmentSizeLimitMb).toBe(
      1024,
    );
    expect(migrateSettings({ backupRetentionDays: -5 }).settings.backupRetentionDays).toBe(1);
  });

  it('falls back to defaults for non-finite and non-numeric values', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '25', null]) {
      expect(migrateSettings({ attachmentSizeLimitMb: bad }).settings.attachmentSizeLimitMb).toBe(
        DEFAULT_SETTINGS.attachmentSizeLimitMb,
      );
    }
  });

  it('falls back to defaults for non-boolean flags', () => {
    // 'false' and 0 are truthy/falsy traps — neither is a boolean.
    expect(migrateSettings({ allowForcePush: 'true' }).settings.allowForcePush).toBe(false);
    expect(migrateSettings({ debugLogging: 1 }).settings.debugLogging).toBe(false);
  });

  describe('connections', () => {
    it('keeps well-formed entries', () => {
      const { settings, warnings } = migrateSettings({ connections: [validConnection] });
      expect(settings.connections).toEqual([validConnection]);
      expect(warnings).toEqual([]);
    });

    it('falls back to the base URL when the display name is missing', () => {
      const { settings } = migrateSettings({
        connections: [{ id: 'c1', baseUrl: 'https://wiki.corp' }],
      });
      expect(settings.connections[0]?.displayName).toBe('https://wiki.corp');
    });

    it('drops entries missing an id or base URL, with a warning', () => {
      const { settings, warnings } = migrateSettings({
        connections: [validConnection, { id: 'c2' }, { baseUrl: 'https://x' }, 'nonsense', null],
      });
      expect(settings.connections).toHaveLength(1);
      expect(warnings).toHaveLength(4);
    });

    it('rejects blank strings as identifiers', () => {
      const { settings } = migrateSettings({
        connections: [{ id: '   ', baseUrl: 'https://wiki.corp' }],
      });
      expect(settings.connections).toHaveLength(0);
    });

    it('ignores a connections value that is not an array', () => {
      expect(migrateSettings({ connections: { id: 'c1' } }).settings.connections).toEqual([]);
    });
  });

  describe('subscriptions', () => {
    it('keeps well-formed entries', () => {
      const { settings } = migrateSettings({ subscriptions: [validSubscription] });
      expect(settings.subscriptions).toEqual([validSubscription]);
    });

    it('treats a missing root page as a whole-space subscription', () => {
      const { rootPageId: _omitted, ...withoutRoot } = validSubscription;
      expect(migrateSettings({ subscriptions: [withoutRoot] }).settings.subscriptions[0]).toEqual(
        expect.objectContaining({ rootPageId: null }),
      );
    });

    it('defaults comment syncing to on', () => {
      const { syncComments: _omitted, ...withoutComments } = validSubscription;
      expect(
        migrateSettings({ subscriptions: [withoutComments] }).settings.subscriptions[0]
          ?.syncComments,
      ).toBe(true);
    });

    it('drops entries missing any required field, with a warning', () => {
      const { settings, warnings } = migrateSettings({
        subscriptions: [
          validSubscription,
          { ...validSubscription, spaceKey: '' },
          { ...validSubscription, mountPath: undefined },
        ],
      });
      expect(settings.subscriptions).toHaveLength(1);
      expect(warnings).toHaveLength(2);
    });
  });
});

describe('SettingsStore', () => {
  it('returns defaults before load is called', () => {
    const store = new SettingsStore(fakePersistence(), silentLogger);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('applies persisted settings on load', async () => {
    const store = new SettingsStore(fakePersistence({ debugLogging: true }), silentLogger);
    await store.load();
    expect(store.get().debugLogging).toBe(true);
  });

  it('loads defaults rather than throwing on corrupt data', async () => {
    const store = new SettingsStore(fakePersistence('not json at all'), silentLogger);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('reports migration warnings through the logger', async () => {
    const logger = new Logger('test', () => false);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const store = new SettingsStore(fakePersistence({ connections: [{}] }), logger);
    await store.load();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('merges a patch and persists the whole settings object', async () => {
    const persistence = fakePersistence();
    const store = new SettingsStore(persistence, silentLogger);
    await store.load();
    await store.update({ debugLogging: true });

    expect(store.get().debugLogging).toBe(true);
    expect(store.get().attachmentSizeLimitMb).toBe(DEFAULT_SETTINGS.attachmentSizeLimitMb);
    expect(persistence.saved).toHaveLength(1);
    expect(persistence.saved[0]).toEqual(store.get());
  });

  it('accumulates successive updates', async () => {
    const store = new SettingsStore(fakePersistence(), silentLogger);
    await store.update({ debugLogging: true });
    await store.update({ allowForcePush: true });
    expect(store.get().debugLogging).toBe(true);
    expect(store.get().allowForcePush).toBe(true);
  });

  it('picks up an external change on reload', async () => {
    const persistence = fakePersistence({ debugLogging: false });
    const store = new SettingsStore(persistence, silentLogger);
    await store.load();
    await persistence.saveData({ debugLogging: true });
    await store.reload();
    expect(store.get().debugLogging).toBe(true);
  });
});
