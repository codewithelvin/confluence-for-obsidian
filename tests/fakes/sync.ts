/**
 * In-memory gateways for the sync engine.
 *
 * Spec §7.5 requires the engine to be testable end to end with zero network and
 * zero file system. These are the two fakes that make that true.
 */

import type {
  ConfluenceGateway,
  ConnectionCheck,
  PageUpdate,
} from '../../src/api/confluence-client';
import type {
  ConfluenceAttachment,
  ConfluencePage,
  ConfluencePageRef,
  ConfluencePageVersion,
} from '../../src/api/api-types';
import { BackupStore } from '../../src/sync/backup-store';
import { AppError } from '../../src/util/errors';
import { sha256 } from '../../src/util/hash';
import { Logger } from '../../src/util/logger';
import { err, ok, type Result } from '../../src/util/result';
import type { ConflictCopy, ConfluenceIdentity } from '../../src/vault/frontmatter';
import type { StateGateway } from '../../src/vault/state-gateway';
import type { NoteWrite, ScannedNote, VaultGateway } from '../../src/vault/vault-gateway';

export class FakeVaultGateway implements VaultGateway {
  readonly files = new Map<string, string>();
  /** Attachments, kept apart from notes: `scan` must never see one as a page. */
  readonly binaries = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly identities = new Map<string, ConfluenceIdentity>();
  readonly writes: string[] = [];
  readonly moves: { from: string; to: string }[] = [];
  readonly trashed: string[] = [];

  /** Paths whose write should fail, to exercise per-page failure isolation. */
  readonly failWrites = new Set<string>();
  vaultLength = 20;

  /** Paths the fake reports as "Save Both" snapshots, which sync must ignore. */
  readonly conflictCopies = new Set<string>();

  /** Seeds a note that the plugin did not write — an untracked candidate. */
  addForeignNote(path: string, content: string): void {
    this.files.set(path, content);
  }

  async scan(folder: string): Promise<Result<readonly ScannedNote[], AppError>> {
    const notes: ScannedNote[] = [];
    for (const [path, content] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (path !== folder && !path.startsWith(`${folder}/`)) continue;
      notes.push({
        path,
        hash: await sha256(content),
        identity: this.identities.get(path) ?? null,
        isConflictCopy: this.conflictCopies.has(path),
      });
    }
    return ok(notes);
  }

  read(path: string): Promise<Result<string, AppError>> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.resolve(err(new AppError('NOT_FOUND', `There is no note at "${path}".`)));
    }
    return Promise.resolve(ok(content));
  }

  async writeNote(write: NoteWrite): Promise<Result<string, AppError>> {
    if (this.failWrites.has(write.path)) {
      return err(new AppError('VAULT_WRITE_FAILED', `Refusing to write ${write.path}`));
    }

    const content = `---\nconfluence:\n  id: ${write.identity.id}\n---\n${write.body}`;
    this.files.set(write.path, content);
    this.identities.set(write.path, write.identity);
    this.writes.push(write.path);
    return Promise.resolve(ok(content));
  }

  /**
   * Rewrites the identity block and leaves the body alone, as the real gateway
   * does — the push path depends on the body surviving a version bump untouched.
   */
  updateIdentity(path: string, identity: ConfluenceIdentity): Promise<Result<string, AppError>> {
    if (this.failWrites.has(path)) {
      return Promise.resolve(err(new AppError('VAULT_WRITE_FAILED', `Refusing to write ${path}`)));
    }

    const existing = this.files.get(path);
    if (existing === undefined) {
      return Promise.resolve(err(new AppError('NOT_FOUND', `There is no note at "${path}".`)));
    }

    const body = existing.replace(/^---\n[\s\S]*?\n---\n/, '');
    const content = `---\nconfluence:\n  id: ${identity.id}\n  version: ${String(identity.version)}\n---\n${body}`;
    this.files.set(path, content);
    this.identities.set(path, identity);
    this.writes.push(path);
    return Promise.resolve(ok(content));
  }

  writeConflictCopy(
    path: string,
    body: string,
    copy: ConflictCopy,
  ): Promise<Result<void, AppError>> {
    if (this.failWrites.has(path)) {
      return Promise.resolve(err(new AppError('VAULT_WRITE_FAILED', `Refusing to write ${path}`)));
    }

    this.files.set(
      path,
      `---\nconfluenceRemoteCopy:\n  pageId: ${copy.pageId}\n  version: ${String(copy.version)}\n---\n${body}`,
    );
    // Recorded as the real gateway's scan would report it, so a later sync in the
    // same test sees a file it must ignore rather than an untracked candidate.
    this.conflictCopies.add(path);
    this.writes.push(path);
    return Promise.resolve(ok(undefined));
  }

  writeBinary(path: string, bytes: ArrayBuffer): Promise<Result<void, AppError>> {
    if (this.failWrites.has(path)) {
      return Promise.resolve(err(new AppError('VAULT_WRITE_FAILED', `Refusing to write ${path}`)));
    }

    this.binaries.set(path, new Uint8Array(bytes));
    this.writes.push(path);
    return Promise.resolve(ok(undefined));
  }

  move(from: string, to: string): Promise<Result<void, AppError>> {
    if (!this.exists(from)) {
      return Promise.resolve(err(new AppError('NOT_FOUND', `Nothing at ${from}`)));
    }
    this.moves.push({ from, to });

    for (const [path, content] of [...this.files]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      const target = `${to}${path.slice(from.length)}`;
      this.files.delete(path);
      this.files.set(target, content);

      const identity = this.identities.get(path);
      this.identities.delete(path);
      if (identity !== undefined) this.identities.set(target, identity);
    }
    this.folders.delete(from);
    this.folders.add(to);
    return Promise.resolve(ok(undefined));
  }

  trash(path: string): Promise<Result<void, AppError>> {
    this.trashed.push(path);
    this.files.delete(path);
    this.identities.delete(path);
    return Promise.resolve(ok(undefined));
  }

  removeEmptyFolder(path: string): Promise<Result<void, AppError>> {
    const occupied = [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
    if (!occupied) this.folders.delete(path);
    return Promise.resolve(ok(undefined));
  }

  exists(path: string): boolean {
    // Attachments count, as they do in Obsidian: `getFileByPath` makes no
    // distinction between a note and a binary. Without them here, FR-8.3 could
    // never see a downloaded attachment and would fetch every image every sync.
    return (
      this.files.has(path) ||
      this.binaries.has(path) ||
      this.folders.has(path) ||
      [...this.files.keys(), ...this.binaries.keys()].some((file) => file.startsWith(`${path}/`))
    );
  }

  readIdentity(path: string): ConfluenceIdentity | null {
    return this.identities.get(path) ?? null;
  }

  vaultPathLength(): number {
    return this.vaultLength;
  }
}

export class FakeStateGateway implements StateGateway {
  readonly files = new Map<string, string>();
  failWrites = false;

  read(name: string): Promise<Result<string | null, AppError>> {
    return Promise.resolve(ok(this.files.get(name) ?? null));
  }

  write(name: string, contents: string): Promise<Result<void, AppError>> {
    if (this.failWrites) {
      return Promise.resolve(err(new AppError('VAULT_WRITE_FAILED', 'state is read-only')));
    }
    this.files.set(name, contents);
    return Promise.resolve(ok(undefined));
  }

  remove(name: string): Promise<Result<void, AppError>> {
    this.files.delete(name);
    return Promise.resolve(ok(undefined));
  }

  list(folder: string): Promise<Result<readonly string[], AppError>> {
    const prefix = `${folder}/`;
    return Promise.resolve(ok([...this.files.keys()].filter((name) => name.startsWith(prefix))));
  }
}

/**
 * A backup store over the same in-memory state a test already has.
 *
 * Every consumer of `SyncEngineDeps`/`NoteServiceDeps` needs one, and it is the
 * kind of dependency a test should not have to think about unless it is the thing
 * under test — in which case it reaches into `state.files` directly.
 */
export function fakeBackups(
  state: StateGateway,
  now: () => string = () => '2026-08-10T12:00:00Z',
): BackupStore {
  return new BackupStore({
    state,
    logger: new Logger('test', () => false),
    retentionDays: () => 14,
    now,
  });
}

export interface FakePage {
  readonly id: string;
  readonly title: string;
  readonly parentId?: string | null;
  readonly version?: number;
  readonly storage?: string;
}

export class FakeConfluence implements ConfluenceGateway {
  pages: FakePage[] = [];
  spaceKey = 'ENG';
  versionSupported = true;
  connectionError: AppError | null = null;
  listError: AppError | null = null;
  readonly failGetPage = new Set<string>();
  readonly fetched: string[] = [];

  checkConnection(): Promise<Result<ConnectionCheck, AppError>> {
    if (this.connectionError !== null) return Promise.resolve(err(this.connectionError));
    return Promise.resolve(
      ok({
        user: { username: 'tester', displayName: 'Tester' },
        version: { raw: '7.19.6', major: 7, minor: 19, patch: 6 },
        versionSupported: this.versionSupported,
      }),
    );
  }

  /** Page the space reports as its home page, which collapses into the mount (D13). */
  homepageId: string | null = null;
  homepageError: AppError | null = null;

  /** Attachments per page id, for the M4 download path. */
  readonly attachments = new Map<string, ConfluenceAttachment[]>();
  readonly downloaded: string[] = [];
  readonly failDownload = new Set<string>();

  listAttachments(pageId: string): Promise<Result<ConfluenceAttachment[], AppError>> {
    if (this.listError !== null) return Promise.resolve(err(this.listError));
    return Promise.resolve(ok(this.attachments.get(pageId) ?? []));
  }

  downloadAttachment(downloadPath: string): Promise<Result<ArrayBuffer, AppError>> {
    if (this.failDownload.has(downloadPath)) {
      return Promise.resolve(
        err(new AppError('NETWORK_UNREACHABLE', `Cannot download ${downloadPath}`)),
      );
    }

    this.downloaded.push(downloadPath);
    // Bytes derived from the path, so a test can tell one attachment from another.
    const bytes = new TextEncoder().encode(downloadPath);
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return Promise.resolve(ok(buffer));
  }

  spaceHomepageId(): Promise<Result<string | null, AppError>> {
    if (this.homepageError !== null) return Promise.resolve(err(this.homepageError));
    return Promise.resolve(ok(this.homepageId));
  }

  listSubtree(): Promise<Result<ConfluencePageRef[], AppError>> {
    if (this.listError !== null) return Promise.resolve(err(this.listError));
    return Promise.resolve(ok(this.pages.map((page) => this.toRef(page))));
  }

  countSubtree(): Promise<Result<number | null, AppError>> {
    return Promise.resolve(ok(this.pages.length));
  }

  getPage(id: string): Promise<Result<ConfluencePage, AppError>> {
    this.fetched.push(id);
    if (this.failGetPage.has(id)) {
      return Promise.resolve(err(new AppError('NOT_FOUND', `no page ${id}`)));
    }

    const page = this.pages.find((candidate) => candidate.id === id);
    if (page === undefined) {
      return Promise.resolve(err(new AppError('NOT_FOUND', `no page ${id}`)));
    }
    return Promise.resolve(ok({ ...this.toRef(page), storage: page.storage ?? '<p>body</p>' }));
  }

  /** Every page update the push path attempted, in order. */
  readonly updates: PageUpdate[] = [];
  /** Page ids whose update should answer 409, to exercise FR-5.5. */
  readonly conflictOnUpdate = new Set<string>();
  updateError: AppError | null = null;

  updatePage(update: PageUpdate): Promise<Result<ConfluencePageVersion, AppError>> {
    this.updates.push(update);

    if (this.conflictOnUpdate.has(update.id)) {
      return Promise.resolve(
        err(
          new AppError(
            'CONFLICT',
            'This page was changed in Confluence since it was last synced.',
            {
              status: 409,
            },
          ),
        ),
      );
    }
    if (this.updateError !== null) return Promise.resolve(err(this.updateError));

    const index = this.pages.findIndex((candidate) => candidate.id === update.id);
    const existing = this.pages[index];
    if (index >= 0 && existing !== undefined) {
      this.pages[index] = {
        ...existing,
        title: update.title,
        version: update.version,
        storage: update.storage,
      };
    }

    return Promise.resolve(
      ok({
        id: update.id,
        title: update.title,
        version: update.version,
        updatedAt: '2026-08-11T09:00:00Z',
        updatedBy: 'tester',
      }),
    );
  }

  private toRef(page: FakePage): ConfluencePageRef {
    return {
      id: page.id,
      title: page.title,
      spaceKey: this.spaceKey,
      version: page.version ?? 1,
      parentId: page.parentId ?? null,
      updatedAt: '2026-08-09T14:03:11Z',
      updatedBy: 'j.smith',
    };
  }
}
