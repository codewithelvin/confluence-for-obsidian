/**
 * Identifier generation for connections and subscriptions.
 *
 * These ids key persisted settings and credential ciphertext, so they must be
 * stable for the lifetime of the entry and unique within the vault.
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Older runtimes: time ordering plus randomness is sufficient here, since
  // ids are only ever compared for equality within one vault.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
