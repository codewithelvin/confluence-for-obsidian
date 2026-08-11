import { FileSystemAdapter, normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { ConfluenceIdentity } from './frontmatter';
import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import { err, ok, type Result } from '../util/result';
import {
  applyAlias,
  CONFLICT_COPY_KEY,
  CONFLUENCE_KEY,
  isConflictCopy,
  joinFrontmatter,
  readIdentity,
  splitFrontmatter,
  toConflictCopyValue,
  toFrontmatterValue,
  type ConflictCopy,
} from './frontmatter';
import {
  isInsideMount,
  outOfMount,
  parentPath,
  vaultWriteFailed,
  type MountSupplier,
  type NoteWrite,
  type ScannedNote,
  type VaultGateway,
} from './vault-gateway';

/**
 * The Obsidian-backed vault gateway (spec §6.3).
 *
 * Every invariant in §6.3 is enforced here rather than by convention:
 * containment before any operation, `fileManager.renameFile` for every move so
 * wikilinks survive, `processFrontMatter` for frontmatter so the user's keys
 * do, and a yield to the event loop every 25 files so a large mount does not
 * freeze the UI.
 */

/** Files processed between yields to the event loop (spec §6.3 rule 5). */
const BATCH_SIZE = 25;

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export class ObsidianVaultGateway implements VaultGateway {
  constructor(
    private readonly app: App,
    private readonly mounts: MountSupplier,
  ) {}

  exists(path: string): boolean {
    const normalised = normalizePath(path);
    return (
      this.app.vault.getFileByPath(normalised) !== null ||
      this.app.vault.getFolderByPath(normalised) !== null
    );
  }

  readIdentity(path: string): ConfluenceIdentity | null {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (file === null) return null;
    return readIdentity(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  vaultPathLength(): number {
    const adapter = this.app.vault.adapter;
    // Desktop-only (decision D5), so this is always a file-system adapter. The
    // guard exists because assuming it would be a crash rather than a fallback.
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath().length + 1 : 0;
  }

  async scan(folder: string): Promise<Result<readonly ScannedNote[], AppError>> {
    const root = normalizePath(folder);
    const guard = this.guard(root);
    if (guard !== null) return err(guard);

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path === root || file.path.startsWith(`${root}/`))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    const scanned: ScannedNote[] = [];
    for (const [index, file] of files.entries()) {
      if (index > 0 && index % BATCH_SIZE === 0) await nextTick();
      const note = await this.scanOne(file);
      if (!note.ok) return note;
      scanned.push(note.value);
    }
    return ok(scanned);
  }

  private async scanOne(file: TFile): Promise<Result<ScannedNote, AppError>> {
    let content: string;
    try {
      content = await this.app.vault.read(file);
    } catch (cause) {
      return err(vaultWriteFailed(file.path, cause));
    }

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return ok({
      path: file.path,
      hash: await sha256(content),
      identity: readIdentity(frontmatter),
      isConflictCopy: isConflictCopy(frontmatter),
    });
  }

  async read(path: string): Promise<Result<string, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    const file = this.app.vault.getFileByPath(normalised);
    if (file === null) {
      return err(new AppError('NOT_FOUND', `There is no note at "${normalised}".`));
    }

    try {
      return ok(await this.app.vault.read(file));
    } catch (cause) {
      return err(vaultWriteFailed(normalised, cause));
    }
  }

  async writeNote(write: NoteWrite): Promise<Result<string, AppError>> {
    const path = normalizePath(write.path);
    const guard = this.guard(path);
    if (guard !== null) return err(guard);

    try {
      const file = await this.writeBody(path, write.body);
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          frontmatter[CONFLUENCE_KEY] = toFrontmatterValue(write.identity);
          applyAlias(frontmatter, write.alias, write.previousAlias);
        },
      );
      return ok(await this.app.vault.read(file));
    } catch (cause) {
      return err(vaultWriteFailed(path, cause));
    }
  }

  async updateIdentity(
    path: string,
    identity: ConfluenceIdentity,
  ): Promise<Result<string, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    const file = this.app.vault.getFileByPath(normalised);
    if (file === null) {
      return err(new AppError('NOT_FOUND', `There is no note at "${normalised}".`));
    }

    try {
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          frontmatter[CONFLUENCE_KEY] = toFrontmatterValue(identity);
        },
      );
      return ok(await this.app.vault.read(file));
    } catch (cause) {
      return err(vaultWriteFailed(normalised, cause));
    }
  }

  async writeConflictCopy(
    path: string,
    body: string,
    copy: ConflictCopy,
  ): Promise<Result<void, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    try {
      const file = await this.writeBody(normalised, body);
      // Through `processFrontMatter` like every other frontmatter write (§7.4),
      // rather than hand-rolled YAML — a snapshot of a page in an unfamiliar
      // language is exactly where hand-rolled quoting goes wrong.
      await this.app.fileManager.processFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          delete frontmatter[CONFLUENCE_KEY];
          frontmatter[CONFLICT_COPY_KEY] = toConflictCopyValue(copy);
        },
      );
      return ok(undefined);
    } catch (cause) {
      return err(vaultWriteFailed(normalised, cause));
    }
  }

  /**
   * Writes an attachment (spec FR-8.1).
   *
   * `modifyBinary` on a file that exists rather than delete-and-create, so the
   * file keeps its identity and every note embedding it keeps working while the
   * write happens.
   */
  async writeBinary(path: string, bytes: ArrayBuffer): Promise<Result<void, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    try {
      const existing = this.app.vault.getFileByPath(normalised);
      if (existing === null) {
        await this.ensureFolder(parentPath(normalised));
        await this.app.vault.createBinary(normalised, bytes);
      } else {
        await this.app.vault.modifyBinary(existing, bytes);
      }
      return ok(undefined);
    } catch (cause) {
      return err(vaultWriteFailed(normalised, cause));
    }
  }

  /**
   * Replaces the body while carrying the existing frontmatter block across
   * verbatim (FR-4.6).
   *
   * `Vault.process` rather than read-then-write: it applies the change against
   * the file's current contents, so an edit made between the read and the write
   * is not silently discarded (spec §7.4).
   */
  private async writeBody(path: string, body: string): Promise<TFile> {
    const existing = this.app.vault.getFileByPath(path);
    if (existing === null) {
      await this.ensureFolder(parentPath(path));
      return this.app.vault.create(path, joinFrontmatter('', body));
    }

    await this.app.vault.process(existing, (current) =>
      joinFrontmatter(splitFrontmatter(current).frontmatter, body),
    );
    return existing;
  }

  async move(from: string, to: string): Promise<Result<void, AppError>> {
    const source = normalizePath(from);
    const target = normalizePath(to);
    const guard = this.guard(source) ?? this.guard(target);
    if (guard !== null) return err(guard);

    const file = this.app.vault.getFileByPath(source) ?? this.app.vault.getFolderByPath(source);
    if (file === null) {
      return err(new AppError('NOT_FOUND', `Nothing to move at "${source}".`));
    }

    try {
      await this.ensureFolder(parentPath(target));
      await this.app.fileManager.renameFile(file, target);
      return ok(undefined);
    } catch (cause) {
      return err(vaultWriteFailed(target, cause));
    }
  }

  async trash(path: string): Promise<Result<void, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    const file =
      this.app.vault.getFileByPath(normalised) ?? this.app.vault.getFolderByPath(normalised);
    if (file === null) return ok(undefined);

    try {
      // Honours the user's own deletion preference — system trash, vault trash
      // or permanent — rather than imposing one.
      await this.app.fileManager.trashFile(file);
      return ok(undefined);
    } catch (cause) {
      return err(vaultWriteFailed(normalised, cause));
    }
  }

  async removeEmptyFolder(path: string): Promise<Result<void, AppError>> {
    const normalised = normalizePath(path);
    const guard = this.guard(normalised);
    if (guard !== null) return err(guard);

    const folder = this.app.vault.getFolderByPath(normalised);
    if (folder === null || folder.children.length > 0) return ok(undefined);
    return this.trash(normalised);
  }

  /** Creates a folder and every missing ancestor, in order. */
  private async ensureFolder(path: string): Promise<void> {
    if (path.length === 0) return;

    const segments = path.split('/');
    let current = '';
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      if (this.app.vault.getFolderByPath(current) !== null) continue;
      await this.app.vault.createFolder(current);
    }
  }

  /** `null` when the path may be touched, otherwise the error explaining why not. */
  private guard(path: string): AppError | null {
    return isInsideMount(path, this.mounts().map(normalizePath)) ? null : outOfMount(path);
  }
}
