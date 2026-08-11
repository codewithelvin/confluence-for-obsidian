import { beforeEach, describe, expect, it } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { ObsidianVaultGateway } from '../../src/vault/obsidian-vault-gateway';
import { ObsidianStateGateway } from '../../src/vault/state-gateway';
import { isInsideMount, parentPath } from '../../src/vault/vault-gateway';
import type { ConfluenceIdentity } from '../../src/vault/frontmatter';
import { App as FakeApp } from '../fakes/obsidian';

/** The gateway takes Obsidian's `App`; the tests hand it the in-memory stand-in. */
function asApp(app: FakeApp): App {
  return app as unknown as App;
}

function asManifest(id: string, dir?: string): PluginManifest {
  return { id, dir, name: id, version: '0.0.1' } as unknown as PluginManifest;
}

const IDENTITY: ConfluenceIdentity = {
  id: '123',
  space: 'ENG',
  version: 4,
  parent: null,
  url: 'https://wiki.corp/pages/viewpage.action?pageId=123',
  updated: '2026-08-09T14:03:11Z',
  updatedBy: 'j.smith',
  fidelity: 'certified',
};

let app: FakeApp;
let gateway: ObsidianVaultGateway;

beforeEach(() => {
  app = new FakeApp();
  gateway = new ObsidianVaultGateway(asApp(app), () => ['Confluence']);
});

function contentAt(path: string): string {
  const content = app.vault.contentOf(path);
  if (content === undefined) throw new Error(`nothing at ${path}`);
  return content;
}

describe('isInsideMount', () => {
  it('accepts the mount itself and anything under it', () => {
    expect(isInsideMount('Confluence', ['Confluence'])).toBe(true);
    expect(isInsideMount('Confluence/ENG/a.md', ['Confluence'])).toBe(true);
  });

  it('rejects a folder that merely starts with the mount name', () => {
    expect(isInsideMount('Confluence-archive/a.md', ['Confluence'])).toBe(false);
  });

  it('rejects anything outside every mount', () => {
    expect(isInsideMount('Personal/a.md', ['Confluence', 'Wiki'])).toBe(false);
  });
});

describe('parentPath', () => {
  it('returns the containing folder', () => {
    expect(parentPath('Confluence/ENG/a.md')).toBe('Confluence/ENG');
  });

  it('returns empty at the vault root rather than a truncated name', () => {
    expect(parentPath('a.md')).toBe('');
    expect(parentPath('/a.md')).toBe('');
  });
});

describe('writeNote', () => {
  it('creates the note and every missing folder', async () => {
    const result = await gateway.writeNote({
      path: 'Confluence/ENG/Architecture/Architecture.md',
      body: '# Architecture\n',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect(result.ok).toBe(true);
    expect(app.vault.allPaths()).toContain('Confluence/ENG/Architecture');
    expect(contentAt('Confluence/ENG/Architecture/Architecture.md')).toContain('# Architecture');
  });

  it('writes the confluence identity into frontmatter', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'text',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    const written = contentAt('Confluence/a.md');

    expect(written).toContain('confluence:');
    // Quoted, because an unquoted page id reads back as a number, and an
    // identity that is not a string is no identity at all.
    expect(written).toContain('id: "123"');
    expect(written).toContain('fidelity: certified');
  });

  it('returns the finished file, not the body it was given', async () => {
    // The caller hashes this to decide whether the note has been edited since.
    // Hashing the intended body instead would make every note look modified.
    const result = await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'text',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect(result.ok && result.value).toBe(contentAt('Confluence/a.md'));
  });

  it('preserves frontmatter keys the user added (spec FR-4.6)', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'first',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    const file = app.vault.getFileByPath('Confluence/a.md');
    if (file === null) throw new Error('note was not created');
    await app.vault.process(file, (content) =>
      content.replace('confluence:', 'reviewed: true\nconfluence:'),
    );

    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'second',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    const written = contentAt('Confluence/a.md');

    expect(written).toContain('reviewed: true');
    expect(written).toContain('second');
    expect(written).not.toContain('first');
  });

  it('updates the identity on a rewrite rather than appending a second block', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: { ...IDENTITY, version: 9, fidelity: 'degraded' },
      alias: null,
      previousAlias: null,
    });

    const written = contentAt('Confluence/a.md');
    expect(written.match(/confluence:/g)).toHaveLength(1);
    expect(written).toContain('version: 9');
    expect(written).toContain('fidelity: degraded');
  });

  it('refuses to write outside the mount', async () => {
    const result = await gateway.writeNote({
      path: 'Personal/secret.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports a failed write instead of throwing', async () => {
    Object.defineProperty(app.vault, 'create', {
      value: () => Promise.reject(new Error('disk full')),
    });

    const result = await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
    expect(!result.ok && result.error.userMessage).toContain('disk full');
  });
});

describe('scan', () => {
  it('returns hash and identity for tracked notes and null identity for others', async () => {
    await gateway.writeNote({
      path: 'Confluence/tracked.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    await app.vault.create('Confluence/untracked.md', 'just a note\n');

    const result = await gateway.scan('Confluence');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [tracked, untracked] = result.value;
    expect(tracked?.identity?.id).toBe('123');
    expect(tracked?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(untracked?.identity).toBeNull();
  });

  it('ignores notes outside the folder', async () => {
    await app.vault.create('Confluence/inside.md', 'a');
    await app.vault.create('Confluence-archive/outside.md', 'b');

    const result = await gateway.scan('Confluence');
    expect(result.ok && result.value.map((note) => note.path)).toEqual(['Confluence/inside.md']);
  });

  it('handles a mount larger than one batch without dropping files', async () => {
    for (let index = 0; index < 30; index += 1) {
      await app.vault.create(`Confluence/note-${String(index).padStart(2, '0')}.md`, 'x');
    }

    const result = await gateway.scan('Confluence');
    expect(result.ok && result.value).toHaveLength(30);
  });

  it('refuses to scan outside the mount', async () => {
    const result = await gateway.scan('Personal');
    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports an unreadable file', async () => {
    await app.vault.create('Confluence/a.md', 'x');
    Object.defineProperty(app.vault, 'read', {
      value: () => Promise.reject(new Error('locked')),
    });

    const result = await gateway.scan('Confluence');
    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
  });
});

describe('move', () => {
  it('moves a note and creates the destination folder', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    const result = await gateway.move('Confluence/a.md', 'Confluence/ENG/Deep/a.md');

    expect(result.ok).toBe(true);
    expect(app.vault.getFileByPath('Confluence/ENG/Deep/a.md')).not.toBeNull();
    expect(app.vault.getFileByPath('Confluence/a.md')).toBeNull();
  });

  it('carries a folder note and its children (decision D9 promotion)', async () => {
    await app.vault.createFolder('Confluence/Old');
    await gateway.writeNote({
      path: 'Confluence/Old/Old.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    await gateway.writeNote({
      path: 'Confluence/Old/Child.md',
      body: 'y',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    const result = await gateway.move('Confluence/Old', 'Confluence/New');

    expect(result.ok).toBe(true);
    expect(app.vault.getFileByPath('Confluence/New/Child.md')).not.toBeNull();
  });

  it('refuses a destination outside the mount', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    const result = await gateway.move('Confluence/a.md', 'Personal/a.md');

    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports a missing source', async () => {
    const result = await gateway.move('Confluence/ghost.md', 'Confluence/b.md');
    expect(!result.ok && result.error.code).toBe('NOT_FOUND');
  });

  it('reports a failed rename', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    Object.defineProperty(app.fileManager, 'renameFile', {
      value: () => Promise.reject(new Error('in use')),
    });

    const result = await gateway.move('Confluence/a.md', 'Confluence/b.md');
    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
  });
});

describe('trash and removeEmptyFolder', () => {
  it('trashes a note', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect((await gateway.trash('Confluence/a.md')).ok).toBe(true);
    expect(app.vault.getFileByPath('Confluence/a.md')).toBeNull();
  });

  it('treats trashing something already gone as success', async () => {
    expect((await gateway.trash('Confluence/ghost.md')).ok).toBe(true);
  });

  it('refuses to trash outside the mount', async () => {
    const result = await gateway.trash('Personal/a.md');
    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports a failed trash', async () => {
    await gateway.writeNote({
      path: 'Confluence/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });
    Object.defineProperty(app.fileManager, 'trashFile', {
      value: () => Promise.reject(new Error('denied')),
    });

    const result = await gateway.trash('Confluence/a.md');
    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
  });

  it('leaves a folder that still has contents', async () => {
    await app.vault.createFolder('Confluence/Keep');
    await gateway.writeNote({
      path: 'Confluence/Keep/a.md',
      body: 'x',
      identity: IDENTITY,
      alias: null,
      previousAlias: null,
    });

    expect((await gateway.removeEmptyFolder('Confluence/Keep')).ok).toBe(true);
    expect(app.vault.getFolderByPath('Confluence/Keep')).not.toBeNull();
  });

  it('removes an empty folder, and ignores one that is not there', async () => {
    await app.vault.createFolder('Confluence/Empty');

    expect((await gateway.removeEmptyFolder('Confluence/Empty')).ok).toBe(true);
    expect(app.vault.getFolderByPath('Confluence/Empty')).toBeNull();
    expect((await gateway.removeEmptyFolder('Confluence/Gone')).ok).toBe(true);
  });

  it('refuses to remove a folder outside the mount', async () => {
    const result = await gateway.removeEmptyFolder('Personal');
    expect(!result.ok && result.error.code).toBe('OUT_OF_MOUNT');
  });
});

describe('exists and vaultPathLength', () => {
  it('sees both files and folders', async () => {
    await app.vault.createFolder('Confluence/ENG');
    await app.vault.create('Confluence/a.md', 'x');

    expect(gateway.exists('Confluence/ENG')).toBe(true);
    expect(gateway.exists('Confluence/a.md')).toBe(true);
    expect(gateway.exists('Confluence/ghost.md')).toBe(false);
  });

  it('measures the vault root, including its separator', () => {
    // The §6.5.3 budget is on the absolute path, so a vault three folders deep
    // spends that depth on every page it holds.
    expect(gateway.vaultPathLength()).toBe('/vault'.length + 1);
  });
});

describe('ObsidianStateGateway', () => {
  const manifest = asManifest('confluence-dc-connector', '.obsidian/plugins/cdc');

  it('treats a missing file as absent rather than an error', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    const result = await state.read('index.json');

    expect(result.ok && result.value).toBeNull();
  });

  it('writes and reads back, creating the state folder', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);

    expect((await state.write('index.json', '{"a":1}')).ok).toBe(true);
    expect((await state.read('index.json')) as unknown).toEqual({ ok: true, value: '{"a":1}' });
    expect(app.vault.adapter.folders.has('.obsidian/plugins/cdc/state')).toBe(true);
  });

  it('leaves no temporary file behind', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    await state.write('index.json', '{}');

    expect([...app.vault.adapter.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('still replaces the file when the platform refuses to rename over it', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    await state.write('index.json', 'first');
    app.vault.adapter.renameOverExistingFails = true;

    expect((await state.write('index.json', 'second')).ok).toBe(true);
    expect(app.vault.adapter.files.get('.obsidian/plugins/cdc/state/index.json')).toBe('second');
  });

  it('nests fragment files under the state folder', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    await state.write('fragments/123.json', '{}');

    expect(app.vault.adapter.files.has('.obsidian/plugins/cdc/state/fragments/123.json')).toBe(
      true,
    );
  });

  it('removes a file, and ignores one that is not there', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    await state.write('index.json', '{}');

    expect((await state.remove('index.json')).ok).toBe(true);
    expect((await state.remove('index.json')).ok).toBe(true);
    expect((await state.read('index.json')).ok).toBe(true);
  });

  it('falls back to the plugin folder when the manifest omits its directory', async () => {
    const state = new ObsidianStateGateway(asApp(app), asManifest('cdc'));
    await state.write('index.json', '{}');

    expect(app.vault.adapter.files.has('.obsidian/plugins/cdc/state/index.json')).toBe(true);
  });

  it('reports a failed write', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    Object.defineProperty(app.vault.adapter, 'write', {
      value: () => Promise.reject(new Error('read-only volume')),
    });

    const result = await state.write('index.json', '{}');
    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
  });

  it('reports a failed read', async () => {
    const state = new ObsidianStateGateway(asApp(app), manifest);
    await state.write('index.json', '{}');
    Object.defineProperty(app.vault.adapter, 'read', {
      value: () => Promise.reject(new Error('corrupt')),
    });

    const result = await state.read('index.json');
    expect(!result.ok && result.error.code).toBe('VAULT_WRITE_FAILED');
  });
});
