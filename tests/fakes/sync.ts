/**
 * In-memory gateways for the sync engine.
 *
 * Spec §7.5 requires the engine to be testable end to end with zero network and
 * zero file system. These are the two fakes that make that true.
 */

import type { ConfluenceGateway, ConnectionCheck } from '../../src/api/confluence-client';
import type { ConfluencePage, ConfluencePageRef } from '../../src/api/api-types';
import { AppError } from '../../src/util/errors';
import { sha256 } from '../../src/util/hash';
import { err, ok, type Result } from '../../src/util/result';
import type { ConfluenceIdentity } from '../../src/vault/frontmatter';
import type { StateGateway } from '../../src/vault/state-gateway';
import type { NoteWrite, ScannedNote, VaultGateway } from '../../src/vault/vault-gateway';

export class FakeVaultGateway implements VaultGateway {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly identities = new Map<string, ConfluenceIdentity>();
  readonly writes: string[] = [];
  readonly moves: { from: string; to: string }[] = [];
  readonly trashed: string[] = [];

  /** Paths whose write should fail, to exercise per-page failure isolation. */
  readonly failWrites = new Set<string>();
  vaultLength = 20;

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
      });
    }
    return ok(notes);
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
    return (
      this.files.has(path) ||
      this.folders.has(path) ||
      [...this.files.keys()].some((file) => file.startsWith(`${path}/`))
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
