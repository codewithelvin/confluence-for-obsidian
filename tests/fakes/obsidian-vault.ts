/**
 * In-memory stand-ins for Obsidian's vault APIs.
 *
 * These exist so the vault gateway — the one module that may touch `app.vault` —
 * can be tested at all. Everything above it is tested against the `VaultGateway`
 * interface instead, with no file system of any kind.
 *
 * Deliberate simplification: `processFrontMatter` here parses and re-serialises,
 * where Obsidian edits the block in place. That keeps the contract the plugin
 * depends on (user keys survive a write) while staying a few dozen lines.
 */

export abstract class TAbstractFile {
  parent: TFolder | null = null;

  constructor(public path: string) {}

  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
}

export class TFile extends TAbstractFile {
  get extension(): string {
    return this.path.slice(this.path.lastIndexOf('.') + 1);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

// ------------------------------------------------------------------ frontmatter

const DELIMITER = '---';

/** Splits a note into its frontmatter block body and the rest. */
function splitBlock(content: string): { yaml: string; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== DELIMITER) return { yaml: '', body: content };

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (end === -1) return { yaml: '', body: content };

  return { yaml: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (value === 'null' || value === '') return null;
  if (value === 'true' || value === 'false') return value === 'true';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(',').map((item) => parseScalar(item));
  }
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/** Handles the shapes this plugin writes: scalars, one level of nesting, simple lists. */
export function parseFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let pending: string | null = null;
  let nested: Record<string, unknown> = {};
  let list: unknown[] = [];

  // A `key:` with nothing after it opens either a nested map or a list; which
  // one only becomes clear on the following line, so it is resolved on close.
  const close = (): void => {
    if (pending === null) return;
    if (list.length > 0) result[pending] = list;
    else result[pending] = Object.keys(nested).length > 0 ? nested : null;
    pending = null;
    nested = {};
    list = [];
  };

  for (const line of yaml.split('\n')) {
    if (line.trim().length === 0) continue;

    if (pending !== null && line.startsWith('  - ')) {
      list.push(parseScalar(line.slice(4)));
      continue;
    }
    if (pending !== null && line.startsWith('  ')) {
      const [key, ...rest] = line.trim().split(':');
      if (key !== undefined) nested[key] = parseScalar(rest.join(':'));
      continue;
    }

    close();
    const [key, ...rest] = line.split(':');
    if (key === undefined) continue;
    const value = rest.join(':').trim();
    if (value.length === 0) pending = key;
    else result[key] = parseScalar(value);
  }

  close();
  return result;
}

/**
 * Quotes a string that would otherwise read back as a number or a boolean.
 *
 * Obsidian's own YAML serialiser does this, and a page id is the case that
 * matters: `id: 123456789` parses back as a number, and an identity that is not
 * a string is no identity at all.
 */
function serialiseValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return /^(-?\d+(\.\d+)?|true|false|null)$/.test(value) ? `"${value}"` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'null';
}

export function serialiseFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [DELIMITER];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`, ...value.map((item) => `  - ${serialiseValue(item)}`));
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [inner, nested] of Object.entries(value)) {
        lines.push(`  ${inner}: ${serialiseValue(nested)}`);
      }
    } else {
      lines.push(`${key}: ${serialiseValue(value)}`);
    }
  }
  lines.push(DELIMITER, '');
  return lines.join('\n');
}

// ----------------------------------------------------------------------- vault

export class FakeAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Set by a test to make the next `rename` fail, as Windows does over an existing file. */
  renameOverExistingFails = false;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }

  read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(content);
  }

  write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    return Promise.resolve();
  }

  mkdir(path: string): Promise<void> {
    this.folders.add(path);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    if (this.renameOverExistingFails && this.files.has(to)) {
      return Promise.reject(new Error('EEXIST'));
    }
    const content = this.files.get(from);
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${from}`));
    this.files.delete(from);
    this.files.set(to, content);
    return Promise.resolve();
  }
}

export class FileSystemAdapter extends FakeAdapter {
  constructor(private readonly basePath = '/vault') {
    super();
  }

  getBasePath(): string {
    return this.basePath;
  }
}

export class Vault {
  readonly configDir = '.obsidian';
  readonly adapter = new FileSystemAdapter();
  private readonly files = new Map<string, TFile>();
  private readonly folders = new Map<string, TFolder>();
  private readonly contents = new Map<string, string>();

  getFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    return this.folders.get(path) ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((file) => file.extension === 'md');
  }

  read(file: TFile): Promise<string> {
    return Promise.resolve(this.contents.get(file.path) ?? '');
  }

  create(path: string, data: string): Promise<TFile> {
    const file = new TFile(path);
    this.files.set(path, file);
    this.contents.set(path, data);
    this.link(file);
    return Promise.resolve(file);
  }

  createFolder(path: string): Promise<TFolder> {
    const folder = new TFolder(path);
    this.folders.set(path, folder);
    this.link(folder);
    return Promise.resolve(folder);
  }

  process(file: TFile, fn: (data: string) => string): Promise<string> {
    const updated = fn(this.contents.get(file.path) ?? '');
    this.contents.set(file.path, updated);
    return Promise.resolve(updated);
  }

  /** Test helper: the raw bytes of a note. */
  contentOf(path: string): string | undefined {
    return this.contents.get(path);
  }

  /** Test helper: every path currently in the vault. */
  allPaths(): string[] {
    return [...this.files.keys(), ...this.folders.keys()].sort();
  }

  remove(file: TAbstractFile): void {
    this.files.delete(file.path);
    this.folders.delete(file.path);
    this.contents.delete(file.path);
    if (file.parent !== null) {
      file.parent.children = file.parent.children.filter((child) => child !== file);
    }
  }

  rename(file: TAbstractFile, target: string): void {
    const descendants = [...this.files.values(), ...this.folders.values()].filter((candidate) =>
      candidate.path.startsWith(`${file.path}/`),
    );
    const source = file.path;
    this.reseat(file, target);
    for (const descendant of descendants) {
      this.reseat(descendant, `${target}${descendant.path.slice(source.length)}`);
    }
  }

  private reseat(file: TAbstractFile, target: string): void {
    const content = this.contents.get(file.path);
    this.remove(file);
    file.path = target;
    if (file instanceof TFolder) this.folders.set(target, file);
    else if (file instanceof TFile) this.files.set(target, file);
    if (content !== undefined) this.contents.set(target, content);
    this.link(file);
  }

  private link(file: TAbstractFile): void {
    const index = file.path.lastIndexOf('/');
    const parent = index <= 0 ? null : (this.folders.get(file.path.slice(0, index)) ?? null);
    file.parent = parent;
    if (parent !== null && !parent.children.includes(file)) parent.children.push(file);
  }
}

export class FileManager {
  constructor(private readonly vault: Vault) {}

  renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    this.vault.rename(file, newPath);
    return Promise.resolve();
  }

  trashFile(file: TAbstractFile): Promise<void> {
    for (const child of [...(file instanceof TFolder ? file.children : [])]) {
      void this.trashFile(child);
    }
    this.vault.remove(file);
    return Promise.resolve();
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: unknown) => void): Promise<void> {
    const content = await this.vault.read(file);
    const { yaml, body } = splitBlock(content);
    const data = parseFrontmatter(yaml);
    fn(data);
    await this.vault.process(file, () => `${serialiseFrontmatter(data)}${body.replace(/^\n/, '')}`);
  }
}

export class MetadataCache {
  constructor(private readonly vault: Vault) {}

  getFileCache(file: TFile): { frontmatter: Record<string, unknown> } | null {
    const content = this.vault.contentOf(file.path);
    if (content === undefined) return null;
    return { frontmatter: parseFrontmatter(splitBlock(content).yaml) };
  }
}
