/**
 * The vault I/O boundary (spec §6.3, §6.1 hard rule).
 *
 * Nothing outside `src/vault/` touches `app.vault`. This interface is what makes
 * the sync engine testable with no file system at all: the tests substitute an
 * in-memory implementation and assert on the writes it received.
 *
 * The interface and its invariants live here; the Obsidian-backed implementation
 * is in `obsidian-vault-gateway.ts`.
 */

import { AppError } from '../util/errors';
import type { Result } from '../util/result';
import type { ConfluenceIdentity } from './frontmatter';

/** A note as the sync engine wants it written: body plus plugin-owned identity. */
export interface NoteWrite {
  readonly path: string;
  /** Converter output. Carries no frontmatter of its own. */
  readonly body: string;
  readonly identity: ConfluenceIdentity;
}

/** What a scan of the mount found for one Markdown file. */
export interface ScannedNote {
  readonly path: string;
  /** sha256 of the file exactly as it is on disk (spec §6.6.3). */
  readonly hash: string;
  /** `null` for a file the plugin does not own — an untracked candidate. */
  readonly identity: ConfluenceIdentity | null;
}

export interface VaultGateway {
  /**
   * Every Markdown file under `folder`, with its hash and identity.
   *
   * Yields to the event loop periodically so a large mount does not freeze the
   * UI (spec §6.3 rule 5, §7.1 budget).
   */
  scan(folder: string): Promise<Result<readonly ScannedNote[], AppError>>;

  /**
   * Creates or replaces a note, preserving any frontmatter keys the user added
   * (FR-4.6), and returns the finished file content so the caller can hash what
   * was actually written rather than what it intended to write.
   */
  writeNote(write: NoteWrite): Promise<Result<string, AppError>>;

  /**
   * Moves a note or folder. Always via `fileManager.renameFile`, which rewrites
   * wikilinks vault-wide — including the user's own links into Confluence
   * content (spec §6.3 rule 2, risk R3).
   */
  move(from: string, to: string): Promise<Result<void, AppError>>;

  /** Sends a file or folder to the configured trash. Never a hard delete. */
  trash(path: string): Promise<Result<void, AppError>>;

  /** Removes a folder only if nothing remains in it. Used to tidy after a move. */
  removeEmptyFolder(path: string): Promise<Result<void, AppError>>;

  exists(path: string): boolean;

  /** The plugin-owned identity in a note's frontmatter, or `null` if it has none. */
  readIdentity(path: string): ConfluenceIdentity | null;

  /** Absolute path length of the vault root, for the §6.5.3 path budget. */
  vaultPathLength(): number;
}

/** Paths the gateway is allowed to touch. Supplied live, so it tracks settings changes. */
export type MountSupplier = () => readonly string[];

export function outOfMount(path: string): AppError {
  return new AppError(
    'OUT_OF_MOUNT',
    `Refused to touch "${path}": it is outside every configured Confluence mount folder.`,
  );
}

export function vaultWriteFailed(path: string, cause: unknown): AppError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AppError('VAULT_WRITE_FAILED', `Could not write "${path}": ${detail}`, { cause });
}

/**
 * Whether a path lies inside one of the mounts.
 *
 * Compared segment-wise rather than by prefix: `Confluence-old/note.md` starts
 * with `Confluence` as a string but is a different folder, and a plain
 * `startsWith` would let the plugin write into it.
 */
export function isInsideMount(path: string, mounts: readonly string[]): boolean {
  return mounts.some((mount) => path === mount || path.startsWith(`${mount}/`));
}

/**
 * Directory containing `path`, or `''` at the root.
 *
 * Written out rather than inlined as `slice(0, lastIndexOf('/'))`, which for a
 * root-level path silently returns the name with its last character removed —
 * producing a folder named after a typo of the file.
 */
export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
}
