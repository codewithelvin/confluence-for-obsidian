/**
 * Content hashing (spec §6.6.3).
 *
 * Change detection hashes content rather than comparing modification times:
 * mtime is rewritten by Dropbox, iCloud and Obsidian Sync on files whose bytes
 * never changed, and is preserved by others on files that did (risk R10).
 *
 * `crypto.subtle` is the platform's own implementation — present in the Electron
 * renderer Obsidian runs in, and in Node for the tests. Nothing is hand-rolled.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Lowercase hex sha256 of a string, encoded as UTF-8. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}
