import type { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { ok, type Result } from '../util/result';
import type { StateGateway } from '../vault/state-gateway';

/**
 * Backups taken before a destructive local write (spec FR-6.6).
 *
 * Answering §16 **O7**: backups live in the **plugin state directory**, not in
 * the vault. A `.md` file inside a mount would be picked up by the mount scan as
 * an untracked candidate (FR-7.2), and anywhere else in the vault is off limits
 * to the plugin entirely (decision D2). Hidden also means they never sync, never
 * enter the graph, and never appear in search — a mirror of a large space can
 * accumulate a great many of them.
 *
 * The price, accepted by the client on 2026-08-11: recovering a backup means
 * opening the plugin folder on disk rather than a note in Obsidian.
 */

const FOLDER = 'backups';

/**
 * Both halves of the file name in one place.
 *
 * The timestamp *is* the record of when the backup was taken: reading it back out
 * of the name is what lets retention be enforced without a second index that
 * could disagree with the folder.
 */
const SEPARATOR = '__';

/** ISO-8601 with the colons a file name cannot hold replaced by hyphens. */
function stampOf(iso: string): string {
  return iso.replace(/\.\d+Z?$/, 'Z').replace(/:/g, '-');
}

/**
 * The instant a backup name encodes, or `null` if it encodes none.
 *
 * `null` means the file is **kept**: pruning something whose age cannot be
 * established would be deleting a user's only copy on a guess.
 */
export function backupTakenAt(name: string): number | null {
  const stamp = name.slice(name.lastIndexOf('/') + 1).split(SEPARATOR)[0] ?? '';
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1T$2:$3:$4Z');
  if (iso === stamp) return null;

  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A vault path flattened into one file-name segment.
 *
 * Folder separators become `-` rather than being dropped, so two notes of the
 * same name in different folders do not collide — the whole point of a backup is
 * that it is the copy of *that* file.
 */
function flatten(notePath: string): string {
  return notePath
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function backupName(takenAt: string, notePath: string): string {
  return `${FOLDER}/${stampOf(takenAt)}${SEPARATOR}${flatten(notePath)}.md`;
}

const MS_PER_DAY = 86_400_000;

export interface BackupStoreDeps {
  readonly state: StateGateway;
  readonly logger: Logger;
  /** Retention in days, from settings (spec FR-6.6, default 14). */
  readonly retentionDays: () => number;
  readonly now: () => string;
}

export class BackupStore {
  constructor(private readonly deps: BackupStoreDeps) {}

  /**
   * Copies a note's current bytes aside before something overwrites them.
   *
   * Called *before* the write, and its failure is the caller's to respect: a
   * destructive write whose backup did not happen must not proceed, or FR-6.6 is
   * a promise the plugin only sometimes keeps.
   */
  async save(notePath: string, content: string): Promise<Result<string, AppError>> {
    const takenAt = this.deps.now();
    const name = backupName(takenAt, notePath);

    const written = await this.deps.state.write(
      name,
      // A header rather than bare content: a folder of flattened names is hard to
      // read, and the one thing a recovering user needs is which note this was.
      `<!-- Backup of ${notePath}, taken ${takenAt} by Confluence DC Connector -->\n${content}`,
    );
    if (!written.ok) return written;

    await this.prune();
    return ok(name);
  }

  /**
   * Removes backups past their retention (FR-6.6).
   *
   * Run after each save rather than on a timer: the plugin has no background
   * work by design, and the moment a backup is taken is exactly when the folder
   * is known to be growing.
   */
  async prune(): Promise<Result<number, AppError>> {
    const listed = await this.deps.state.list(FOLDER);
    if (!listed.ok) return listed;

    const cutoff = Date.parse(this.deps.now()) - this.deps.retentionDays() * MS_PER_DAY;
    let removed = 0;

    for (const name of listed.value) {
      const takenAt = backupTakenAt(name);
      if (takenAt === null || takenAt >= cutoff) continue;

      const gone = await this.deps.state.remove(name);
      if (gone.ok) removed += 1;
      else this.deps.logger.warn(gone.error.userMessage);
    }

    if (removed > 0) this.deps.logger.debug(`Pruned ${String(removed)} expired backup(s).`);
    return ok(removed);
  }
}
