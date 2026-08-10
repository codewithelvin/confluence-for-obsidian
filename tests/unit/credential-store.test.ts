import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore, type SafeStorageLike } from '../../src/auth/credential-store';
import { SettingsStore, type SettingsPersistence } from '../../src/settings/settings-store';
import { Logger, clearRegisteredSecrets, redact } from '../../src/util/logger';

const TOKEN = 'NDkyMzk4NzM0OTg3MzQ5OA';
const CONNECTION = 'conn-1';

/**
 * Stands in for the OS keychain. The transform is genuinely obscuring rather
 * than an encoding, so "the plaintext never reaches disk" is a real assertion
 * and not satisfied by base64 alone.
 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Array.from(Buffer.from(plain, 'utf8'), (b) => b ^ 0x5a)),
    decryptString: (buf) => Buffer.from(Array.from(buf, (b) => b ^ 0x5a)).toString('utf8'),
  };
}

function brokenSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('unrelated', 'utf8'),
    decryptString: () => {
      throw new Error('decryption failed: key not found in this keychain');
    },
  };
}

function fakePersistence(initial: unknown = null): SettingsPersistence & { latest: () => unknown } {
  let stored = initial;
  return {
    latest: () => stored,
    loadData: () => Promise.resolve(stored),
    saveData: (data: unknown) => {
      stored = data;
      return Promise.resolve();
    },
  };
}

function setup(safeStorage: SafeStorageLike | null, initial: unknown = null) {
  const persistence = fakePersistence(initial);
  const logger = new Logger('test', () => false);
  const settings = new SettingsStore(persistence, logger);
  const store = new CredentialStore(safeStorage, settings, logger);
  return { store, settings, persistence, logger };
}

describe('CredentialStore with an available keychain', () => {
  afterEach(clearRegisteredSecrets);

  it('never writes the plaintext token to disk', async () => {
    const { store, persistence } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);

    const serialised = JSON.stringify(persistence.latest());
    expect(serialised).not.toContain(TOKEN);
    // Nor a trivially reversible encoding of it.
    expect(serialised).not.toContain(Buffer.from(TOKEN, 'utf8').toString('base64'));
  });

  it('persists ciphertext under the connection id', async () => {
    const { store, settings } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);

    expect(Object.keys(settings.get().credentials)).toEqual([CONNECTION]);
    expect(settings.get().credentials[CONNECTION]).toBeTruthy();
  });

  it('round-trips the token', async () => {
    const { store } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);

    expect(store.get(CONNECTION)).toBe(TOKEN);
  });

  it('decrypts a token persisted by a previous session', async () => {
    const first = setup(fakeSafeStorage());
    await first.store.set(CONNECTION, TOKEN);

    // A fresh store over the same data.json, as after an Obsidian restart.
    const second = setup(fakeSafeStorage(), first.persistence.latest());
    await second.settings.load();

    expect(second.store.get(CONNECTION)).toBe(TOKEN);
  });

  it('registers the token so it is redacted from all logging', async () => {
    const { store } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);

    expect(redact(`request failed with ${TOKEN}`)).not.toContain(TOKEN);
  });

  it('reports that credentials persist across restarts', () => {
    expect(setup(fakeSafeStorage()).store.persistenceAvailable).toBe(true);
  });

  it('returns null for a connection with no stored token', () => {
    expect(setup(fakeSafeStorage()).store.get('unknown-connection')).toBeNull();
  });

  it('reports availability through has()', async () => {
    const { store } = setup(fakeSafeStorage());
    expect(store.has(CONNECTION)).toBe(false);
    await store.set(CONNECTION, TOKEN);
    expect(store.has(CONNECTION)).toBe(true);
  });
});

describe('CredentialStore without a keychain', () => {
  afterEach(clearRegisteredSecrets);

  it.each([
    ['no safeStorage module', null],
    ['encryption unavailable', fakeSafeStorage(false)],
  ])('holds the token in memory only when %s', async (_label, safeStorage) => {
    // Spec FR-1.5: degrade to session-only, never to plaintext on disk.
    const { store, settings, persistence } = setup(safeStorage);
    await store.set(CONNECTION, TOKEN);

    expect(store.get(CONNECTION)).toBe(TOKEN);
    expect(settings.get().credentials).toEqual({});
    expect(JSON.stringify(persistence.latest() ?? {})).not.toContain(TOKEN);
  });

  it('warns the user that the token will not survive a restart', async () => {
    const { store, logger } = setup(null);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await store.set(CONNECTION, TOKEN);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('memory only');
  });

  it('reports that credentials do not persist', () => {
    expect(setup(null).store.persistenceAvailable).toBe(false);
    expect(setup(fakeSafeStorage(false)).store.persistenceAvailable).toBe(false);
  });

  it('treats a throwing availability check as unavailable', () => {
    const throwing: SafeStorageLike = {
      isEncryptionAvailable: () => {
        throw new Error('remote bridge unavailable');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };
    expect(setup(throwing).store.persistenceAvailable).toBe(false);
  });
});

describe('CredentialStore failure handling', () => {
  afterEach(clearRegisteredSecrets);

  it('returns null when stored ciphertext cannot be decrypted on this machine', async () => {
    // The expected case when a vault is copied to another computer: the
    // ciphertext is bound to the keychain that produced it.
    const seeded = { credentials: { [CONNECTION]: 'c29tZS1jaXBoZXJ0ZXh0' } };
    const { store, settings, logger } = setup(brokenSafeStorage(), seeded);
    await settings.load();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(store.get(CONNECTION)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps the token usable in memory when encryption fails', async () => {
    const failing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('keychain locked');
      },
      decryptString: () => '',
    };
    const { store, settings, logger } = setup(failing);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const result = await store.set(CONNECTION, TOKEN);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CREDENTIALS_UNAVAILABLE');
    expect(store.get(CONNECTION)).toBe(TOKEN);
    expect(settings.get().credentials).toEqual({});
  });
});

describe('CredentialStore clearing', () => {
  afterEach(clearRegisteredSecrets);

  it('removes the token from memory and from disk', async () => {
    const { store, settings } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);
    await store.clear(CONNECTION);

    expect(store.get(CONNECTION)).toBeNull();
    expect(settings.get().credentials).toEqual({});
  });

  it('leaves other connections untouched', async () => {
    const { store, settings } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);
    await store.set('conn-2', 'OTHER-TOKEN-VALUE');
    await store.clear(CONNECTION);

    expect(Object.keys(settings.get().credentials)).toEqual(['conn-2']);
    expect(store.get('conn-2')).toBe('OTHER-TOKEN-VALUE');
  });

  it('drops in-memory tokens but keeps ciphertext on forgetSession', async () => {
    const { store, settings } = setup(fakeSafeStorage());
    await store.set(CONNECTION, TOKEN);

    store.forgetSession();

    expect(settings.get().credentials[CONNECTION]).toBeTruthy();
    expect(store.get(CONNECTION)).toBe(TOKEN);
  });
});
