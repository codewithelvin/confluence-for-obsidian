import { normalizePath } from 'obsidian';
import type { App, PluginManifest } from 'obsidian';
import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import { parentPath } from './vault-gateway';

/**
 * Plugin state files (spec §6.6.1, FR-4.3).
 *
 * The sync index and the preserved placeholder fragments are plugin bookkeeping,
 * not user content: they live under the plugin's own folder in the config
 * directory, where they are invisible in the file explorer and excluded from
 * Obsidian's search and graph.
 *
 * This is in `src/vault/` because it reaches `app.vault.adapter`, and nothing
 * outside `src/vault/` may touch the vault (spec §6.1, hard rule).
 */

export interface StateGateway {
  /** File contents, or `null` if it does not exist. A missing file is not an error. */
  read(name: string): Promise<Result<string | null, AppError>>;
  /** Writes atomically: a crash mid-write leaves the previous version intact. */
  write(name: string, contents: string): Promise<Result<void, AppError>>;
  remove(name: string): Promise<Result<void, AppError>>;
}

function stateWriteFailed(name: string, cause: unknown): AppError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AppError(
    'VAULT_WRITE_FAILED',
    `Could not save the plugin's sync state ("${name}"): ${detail}`,
    { cause },
  );
}

export class ObsidianStateGateway implements StateGateway {
  private readonly root: string;

  constructor(
    private readonly app: App,
    manifest: PluginManifest,
  ) {
    // `manifest.dir` is optional in the API but always set for an installed
    // plugin. The fallback keeps a missing value from producing a path rooted
    // at the vault, which would scatter state files among the user's notes.
    const dir = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`;
    this.root = normalizePath(`${dir}/state`);
  }

  async read(name: string): Promise<Result<string | null, AppError>> {
    const path = this.resolve(name);
    try {
      if (!(await this.app.vault.adapter.exists(path))) return ok(null);
      return ok(await this.app.vault.adapter.read(path));
    } catch (cause) {
      return err(stateWriteFailed(name, cause));
    }
  }

  /**
   * Writes to a temporary file and renames it over the target.
   *
   * A half-written index is worse than a missing one: a missing index is
   * rebuilt from frontmatter, but a truncated one parses into a smaller index
   * and makes the next sync re-download pages it already has — or, worse,
   * treat tracked notes as untracked.
   */
  async write(name: string, contents: string): Promise<Result<void, AppError>> {
    const path = this.resolve(name);
    const temporary = `${path}.tmp`;

    try {
      await this.ensureFolder(parentPath(path));
      await this.app.vault.adapter.write(temporary, contents);

      try {
        await this.app.vault.adapter.rename(temporary, path);
      } catch {
        // Some platforms refuse to rename onto an existing file. Removing it
        // first reopens a small window where neither version is on disk, which
        // is still better than writing over the live file in place.
        await this.app.vault.adapter.remove(path);
        await this.app.vault.adapter.rename(temporary, path);
      }
      return ok(undefined);
    } catch (cause) {
      return err(stateWriteFailed(name, cause));
    }
  }

  async remove(name: string): Promise<Result<void, AppError>> {
    const path = this.resolve(name);
    try {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
      return ok(undefined);
    } catch (cause) {
      return err(stateWriteFailed(name, cause));
    }
  }

  private resolve(name: string): string {
    return normalizePath(`${this.root}/${name}`);
  }

  private async ensureFolder(path: string): Promise<void> {
    if (path.length === 0) return;
    if (await this.app.vault.adapter.exists(path)) return;

    await this.ensureFolder(parentPath(path));
    await this.app.vault.adapter.mkdir(path);
  }
}
