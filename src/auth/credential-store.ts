import { AppError } from '../util/errors';
import { readPath } from '../util/guards';
import { registerSecret, type Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import type { SettingsStore } from '../settings/settings-store';

/**
 * Personal Access Token storage (spec D5, FR-1.3 to FR-1.5, FR-1.9).
 *
 * A token is encrypted by the operating system keychain before it is persisted,
 * so the ciphertext in `data.json` is bound to this machine and useless to
 * anyone who obtains the vault through Dropbox, iCloud, git or a backup.
 *
 * When the keychain is unavailable — routinely the case on Linux without a
 * running secret service — the store degrades to memory-only and the user
 * re-enters the token each session. It never degrades to plaintext on disk.
 */

/** The subset of Electron's `safeStorage` this plugin uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Exported for testing: the shape check that decides whether the bridge is usable. */
export function isSafeStorage(candidate: unknown): candidate is SafeStorageLike {
  if (candidate === null || typeof candidate !== 'object') return false;
  const record = candidate as Record<string, unknown>;
  return (
    typeof record['isEncryptionAvailable'] === 'function' &&
    typeof record['encryptString'] === 'function' &&
    typeof record['decryptString'] === 'function'
  );
}

/**
 * Resolves Electron's `safeStorage`.
 *
 * `safeStorage` lives in the main process, so the renderer reaches it through
 * `@electron/remote`. Every step is guarded: this is best-effort by design, and
 * a `null` result is a supported state, not a failure.
 */
export function resolveSafeStorage(): SafeStorageLike | null {
  try {
    if (typeof require !== 'function') return null;
    const requireModule = require as unknown as (id: string) => unknown;
    const candidate = readPath(requireModule('electron'), 'remote', 'safeStorage');
    return isSafeStorage(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export class CredentialStore {
  /** Plaintext tokens, memory only, never persisted. */
  private readonly session = new Map<string, string>();

  constructor(
    private readonly safeStorage: SafeStorageLike | null,
    private readonly settings: SettingsStore,
    private readonly logger: Logger,
  ) {}

  /** Whether tokens survive a restart. False means memory-only (spec FR-1.5). */
  get persistenceAvailable(): boolean {
    try {
      return this.safeStorage !== null && this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Stores a token, encrypting it when the keychain permits. */
  async set(connectionId: string, token: string): Promise<Result<void, AppError>> {
    // Register first: from this point the token is redacted from all logging,
    // including exceptions raised by code we do not control.
    registerSecret(token);
    this.session.set(connectionId, token);

    if (!this.persistenceAvailable || this.safeStorage === null) {
      this.logger.warn(
        'The OS keychain is unavailable, so the token is held in memory only and must be ' +
          're-entered after each restart. It will not be written to disk.',
      );
      return ok(undefined);
    }

    try {
      const ciphertext = this.safeStorage.encryptString(token).toString('base64');
      await this.settings.update({
        credentials: { ...this.settings.get().credentials, [connectionId]: ciphertext },
      });
      return ok(undefined);
    } catch (cause) {
      this.logger.error('Failed to encrypt the token; it will be kept in memory only.', cause);
      return err(
        new AppError('CREDENTIALS_UNAVAILABLE', 'Could not store the token securely.', { cause }),
      );
    }
  }

  /** Returns the token, or `null` if none is available for this connection. */
  get(connectionId: string): string | null {
    const cached = this.session.get(connectionId);
    if (cached !== undefined) return cached;

    const ciphertext = this.settings.get().credentials[connectionId];
    if (ciphertext === undefined || this.safeStorage === null) return null;

    try {
      const token = this.safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
      registerSecret(token);
      this.session.set(connectionId, token);
      return token;
    } catch (cause) {
      // Expected when a vault is copied to another machine: the ciphertext is
      // bound to the keychain that produced it.
      this.logger.warn(
        'The stored token could not be decrypted on this machine. Re-enter it in settings.',
        cause,
      );
      return null;
    }
  }

  has(connectionId: string): boolean {
    return this.get(connectionId) !== null;
  }

  /** Removes a token from memory and from disk (spec FR-1.9). */
  async clear(connectionId: string): Promise<void> {
    this.session.delete(connectionId);

    const { [connectionId]: _removed, ...remaining } = this.settings.get().credentials;
    await this.settings.update({ credentials: remaining });
  }

  /** Drops in-memory tokens without touching persisted ciphertext. */
  forgetSession(): void {
    this.session.clear();
  }
}
