import { beforeEach, describe, expect, it } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { ConfluenceClient } from '../../src/api/confluence-client';
import { DEFAULT_RETRY, Semaphore } from '../../src/api/rate-limiter';
import { parseUpdatedPage } from '../../src/api/api-types';
import { Logger } from '../../src/util/logger';
import {
  conflictCopyPath,
  isConflictCopy,
  type ConflictCopy,
  type ConfluenceIdentity,
} from '../../src/vault/frontmatter';
import { ObsidianVaultGateway } from '../../src/vault/obsidian-vault-gateway';
import { ObsidianStateGateway } from '../../src/vault/state-gateway';
import { App as FakeApp } from '../fakes/obsidian';
import type { HttpRequest } from '../../src/api/http-transport';
import { jsonResponse, recordingTransport, testScheduler } from '../fakes/http';

/**
 * The gateway surface M5 added (spec §6.2.1, §6.3).
 *
 * Read a note, rewrite only its identity block, write a conflict copy, list state
 * files, and `PUT` a page. Each is a boundary the layers above cannot be tested
 * without, and each carries an invariant of its own — most importantly that a
 * version bump does not rewrite the user's body.
 */

const IDENTITY: ConfluenceIdentity = {
  id: '123',
  space: 'ENG',
  version: 5,
  parent: '100',
  url: 'https://wiki.corp/pages/viewpage.action?pageId=123',
  updated: '2026-08-11T09:00:00Z',
  updatedBy: 'e.huseynov',
  fidelity: 'certified',
};

const COPY: ConflictCopy = {
  pageId: '123',
  space: 'ENG',
  version: 43,
  updated: '2026-08-09T14:03:11Z',
  updatedBy: 'j.smith',
  url: 'https://wiki.corp/pages/viewpage.action?pageId=123',
};

let app: FakeApp;
let gateway: ObsidianVaultGateway;

function asApp(value: FakeApp): App {
  return value as unknown as App;
}

beforeEach(() => {
  app = new FakeApp();
  gateway = new ObsidianVaultGateway(asApp(app), () => ['Confluence']);
});

describe('reading a note for a push (§6.3)', () => {
  it('returns the file exactly as it is on disk', async () => {
    await app.vault.create('Confluence/A.md', '---\nconfluence:\n  id: 1\n---\nBody text.\n');

    const read = await gateway.read('Confluence/A.md');

    expect(read.ok && read.value).toContain('Body text.');
  });

  it('refuses a path outside every mount', async () => {
    const read = await gateway.read('Personal/Diary.md');

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('OUT_OF_MOUNT');
  });

  it('reports a missing note rather than returning an empty body', async () => {
    // An empty body pushed to Confluence would blank the page.
    const read = await gateway.read('Confluence/Gone.md');

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe('NOT_FOUND');
  });
});

describe('rewriting only the identity block (§6.5.1)', () => {
  it('bumps the recorded version and leaves the body alone', async () => {
    await app.vault.create(
      'Confluence/A.md',
      '---\nconfluence:\n  id: 123\n  version: 4\nproject: mine\n---\nThe words I wrote.\n',
    );

    const written = await gateway.updateIdentity('Confluence/A.md', IDENTITY);

    if (!written.ok) throw new Error(written.error.userMessage);
    expect(written.value).toContain('The words I wrote.');
    expect(written.value).toContain('version: 5');
  });

  it("preserves the user's own frontmatter keys (FR-4.6)", async () => {
    await app.vault.create(
      'Confluence/A.md',
      '---\nconfluence:\n  id: 123\nproject: mine\n---\nBody.\n',
    );

    const written = await gateway.updateIdentity('Confluence/A.md', IDENTITY);

    expect(written.ok && written.value).toContain('project: mine');
  });

  it('returns the finished content so the caller hashes what was written', async () => {
    await app.vault.create('Confluence/A.md', '---\nconfluence:\n  id: 123\n---\nBody.\n');

    const written = await gateway.updateIdentity('Confluence/A.md', IDENTITY);

    expect(written.ok && written.value).toBe(app.vault.contentOf('Confluence/A.md'));
  });

  it('refuses outside the mount and reports a missing note', async () => {
    expect((await gateway.updateIdentity('Personal/A.md', IDENTITY)).ok).toBe(false);
    expect((await gateway.updateIdentity('Confluence/Gone.md', IDENTITY)).ok).toBe(false);
  });
});

describe('the conflict copy (FR-6.4)', () => {
  it('is named after the note and the remote version', () => {
    expect(conflictCopyPath('ENG/Data Model/Schema.md', 43)).toBe(
      'ENG/Data Model/Schema (remote v43).md',
    );
  });

  it('carries the marker that keeps sync away from it, and no identity', async () => {
    const written = await gateway.writeConflictCopy(
      'Confluence/A (remote v43).md',
      'Their text.',
      COPY,
    );

    if (!written.ok) throw new Error(written.error.userMessage);
    const content = app.vault.contentOf('Confluence/A (remote v43).md') ?? '';
    expect(content).toContain('confluenceRemoteCopy');
    expect(content).toContain('Their text.');
    // A copy carrying `confluence:` would be mistaken for the note itself and
    // pushed over the page it was saved to protect.
    expect(content).not.toMatch(/^confluence:/m);
  });

  it('is reported by a scan as a copy rather than as an untracked candidate', async () => {
    await gateway.writeConflictCopy('Confluence/A (remote v43).md', 'Their text.', COPY);

    const scanned = await gateway.scan('Confluence');

    if (!scanned.ok) throw new Error('scan failed');
    expect(scanned.value[0]?.isConflictCopy).toBe(true);
    expect(scanned.value[0]?.identity).toBeNull();
  });

  it('drops any identity block that was already there', async () => {
    // Overwriting an earlier copy at the same path, or a note the user moved into
    // its place. Either way the result must not look like a tracked note.
    await app.vault.create(
      'Confluence/A (remote v43).md',
      '---\nconfluence:\n  id: 999\n---\nold\n',
    );

    await gateway.writeConflictCopy('Confluence/A (remote v43).md', 'Their text.', COPY);

    expect(gateway.readIdentity('Confluence/A (remote v43).md')).toBeNull();
  });

  it('is recognised by the marker alone, however its fields were edited', () => {
    // The exclusion is the safety property; the fields are only there for the reader.
    expect(isConflictCopy({ confluenceRemoteCopy: 'hand-edited nonsense' })).toBe(true);
    expect(isConflictCopy({ confluence: { id: '1' } })).toBe(false);
    expect(isConflictCopy(null)).toBe(false);
  });

  it('refuses a path outside the mount', async () => {
    const written = await gateway.writeConflictCopy('Personal/A.md', 'x', COPY);

    expect(written.ok).toBe(false);
  });
});

describe('listing state files for backup retention (FR-6.6)', () => {
  function stateGateway(): ObsidianStateGateway {
    return new ObsidianStateGateway(asApp(app), {
      id: 'confluence-dc-connector',
      dir: '.obsidian/plugins/confluence-dc-connector',
    } as unknown as PluginManifest);
  }

  it('returns names the caller can hand straight back to read or remove', async () => {
    const state = stateGateway();
    await state.write('backups/one.md', 'first');
    await state.write('backups/two.md', 'second');

    const listed = await state.list('backups');

    if (!listed.ok) throw new Error(listed.error.userMessage);
    expect([...listed.value].sort()).toEqual(['backups/one.md', 'backups/two.md']);
    expect((await state.read('backups/one.md')).ok).toBe(true);
  });

  it('treats a folder that does not exist as empty rather than as an error', async () => {
    const listed = await stateGateway().list('backups');

    expect(listed.ok && listed.value).toEqual([]);
  });

  it('does not list the sync index alongside the backups', async () => {
    const state = stateGateway();
    await state.write('index.json', '{}');
    await state.write('backups/one.md', 'first');

    const listed = await state.list('backups');

    expect(listed.ok && listed.value).toEqual(['backups/one.md']);
  });
});

describe('updating a page over HTTP (§6.2.1, FR-5.4)', () => {
  const UPDATED = {
    id: '123',
    title: 'Architecture',
    version: { number: 6, when: '2026-08-11T09:00:00Z', by: { username: 'e.huseynov' } },
  };

  /**
   * The request body as JSON.
   *
   * Narrowed rather than coerced: `HttpRequest.body` is `string | ArrayBuffer`
   * because the same transport carries attachment uploads, and stringifying the
   * buffer branch would silently assert on `[object ArrayBuffer]`.
   */
  function jsonBodyOf(request: HttpRequest | undefined): Record<string, unknown> {
    const body = request?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON request body');
    return JSON.parse(body) as Record<string, unknown>;
  }

  function makeClient(script: readonly ReturnType<typeof jsonResponse>[]) {
    const transport = recordingTransport(script);
    const client = new ConfluenceClient('https://wiki.corp/confluence', () => 'PAT', {
      transport,
      semaphore: new Semaphore(4),
      scheduler: testScheduler(1),
      retry: DEFAULT_RETRY,
      logger: new Logger('test', () => false),
      pageSize: 2,
    });
    return { client, transport };
  }

  it('PUTs the storage body to the page, with the version it claims', async () => {
    const { client, transport } = makeClient([jsonResponse(UPDATED)]);

    const result = await client.updatePage({
      id: '123',
      title: 'Architecture',
      spaceKey: 'ENG',
      parentId: '100',
      version: 6,
      storage: '<p>New body.</p>',
    });

    if (!result.ok) throw new Error(result.error.userMessage);
    const request = transport.requests[0];
    expect(request?.method).toBe('PUT');
    expect(request?.url).toBe('https://wiki.corp/confluence/rest/api/content/123');
    expect(request?.headers['Content-Type']).toBe('application/json');

    const body = jsonBodyOf(request);
    expect(body['version']).toEqual({ number: 6, message: 'Updated from Obsidian' });
    expect(body['body']).toEqual({
      storage: { value: '<p>New body.</p>', representation: 'storage' },
    });
    expect(result.value.version).toBe(6);
  });

  it('sends the ancestors so the page is not reparented to the top of the space', async () => {
    const { client, transport } = makeClient([jsonResponse(UPDATED)]);

    await client.updatePage({
      id: '123',
      title: 'Architecture',
      spaceKey: 'ENG',
      parentId: '100',
      version: 6,
      storage: '<p>x</p>',
    });

    const body = jsonBodyOf(transport.requests[0]);
    expect(body['ancestors']).toEqual([{ id: '100' }]);
  });

  it('omits ancestors for a page that has no parent', async () => {
    // A top-level page has no ancestor to send, and `[{ id: null }]` is rejected.
    const { client, transport } = makeClient([jsonResponse(UPDATED)]);

    await client.updatePage({
      id: '123',
      title: 'Architecture',
      spaceKey: 'ENG',
      parentId: null,
      version: 6,
      storage: '<p>x</p>',
    });

    const body = jsonBodyOf(transport.requests[0]);
    expect('ancestors' in body).toBe(false);
  });

  it('maps a 409 to a conflict without retrying it (FR-5.5)', async () => {
    const { client, transport } = makeClient([jsonResponse({ message: 'stale' }, 409)]);

    const result = await client.updatePage({
      id: '123',
      title: 'Architecture',
      spaceKey: 'ENG',
      parentId: null,
      version: 6,
      storage: '<p>x</p>',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFLICT');
    // Exactly one attempt. A retry could push the body a second time.
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses a response that does not report the new version', async () => {
    // Recording a guessed version would make the *next* push send a stale one — a
    // conflict the user never caused.
    const { client } = makeClient([jsonResponse({ id: '123', title: 'Architecture' })]);

    const result = await client.updatePage({
      id: '123',
      title: 'Architecture',
      spaceKey: 'ENG',
      parentId: null,
      version: 6,
      storage: '<p>x</p>',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MALFORMED_RESPONSE');
  });

  it('validates the update response on its own', () => {
    expect(parseUpdatedPage({ id: '1', version: { number: 3 } }).ok).toBe(true);
    expect(parseUpdatedPage({ id: '1' }).ok).toBe(false);
    expect(parseUpdatedPage({ version: { number: 3 } }).ok).toBe(false);
    expect(parseUpdatedPage('not an object').ok).toBe(false);
  });
});
