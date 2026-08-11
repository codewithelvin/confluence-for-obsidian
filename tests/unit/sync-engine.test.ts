import { beforeEach, describe, expect, it } from 'vitest';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncEngine } from '../../src/sync/sync-engine';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import type { SyncCallbacks, SyncProgress, SyncReport } from '../../src/sync/sync-types';
import type { LocalPage } from '../../src/sync/pull-planner';
import type { Subscription } from '../../src/settings/settings-types';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';

const NOW = '2026-08-10T12:00:00Z';

/** Attachment limits the engine needs; generous, so no test trips FR-8.4 by accident. */
const LIMITS = { attachmentLimitBytes: 25 * 1_048_576, attachmentsReferencedOnly: true };

const SUBSCRIPTION: Subscription = {
  id: 'sub',
  connectionId: 'conn',
  spaceKey: 'ENG',
  rootPageId: null,
  mountPath: 'ENG',
  syncComments: true,
};

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let state: SyncStateStore;
let suspensions: SuspensionRegistry;
let client: FakeConfluence;
let engine: SyncEngine;

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  suspensions = new SuspensionRegistry();
  client = new FakeConfluence();

  await state.load();
  engine = new SyncEngine({
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    suspensions,
    logger: new Logger('test', () => false),
    now: () => NOW,
  });
});

async function sync(callbacks: SyncCallbacks = {}): Promise<SyncReport> {
  const result = await engine.sync(
    {
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    },
    callbacks,
  );
  if (!result.ok) throw new Error(`sync failed: ${result.error.userMessage}`);
  return result.value;
}

const acceptDeletions = { confirmDeletions: (): Promise<boolean> => Promise.resolve(true) };

describe('the space home page collapses into the mount (decision D13)', () => {
  it('writes the home page as the mount folder note and its children beside it', async () => {
    client.homepageId = '1';
    client.pages = [
      { id: '1', title: 'E-Portal home' },
      { id: '2', title: 'Architecture', parentId: '1' },
    ];

    await sync();

    expect([...vault.files.keys()].sort()).toEqual(['ENG/Architecture.md', 'ENG/ENG.md']);
  });

  it('keeps the home page title as an alias, since the file name came from the mount', async () => {
    client.homepageId = '1';
    client.pages = [{ id: '1', title: 'E-Portal home' }];

    await sync();

    expect(state.forSubscription('sub').pages['1']?.alias).toBe('E-Portal home');
  });

  it('fails the sync rather than laying the mirror out differently', async () => {
    // Treating an unreadable home page as "there is no home page" would shift
    // every path in the mount up one level, turning a network blip into a mass
    // file move (D13).
    client.homepageId = '1';
    client.homepageError = new AppError('NETWORK_UNREACHABLE', 'The space could not be read.');
    client.pages = [{ id: '1', title: 'E-Portal home' }];

    const result = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(result.ok).toBe(false);
    expect(vault.files.size).toBe(0);
  });
});

describe('attachments (FR-8.1 to FR-8.5)', () => {
  const IMAGE = '<p><ac:image><ri:attachment ri:filename="a.png"/></ac:image></p>';

  function withImage(size: number | null = 1024): void {
    client.pages = [{ id: '1', title: 'A', storage: IMAGE }];
    client.attachments.set('1', [
      { id: 'att1', filename: 'a.png', version: 3, size, downloadPath: '/download/a.png' },
    ]);
  }

  it('downloads the attachment and embeds it in the note', async () => {
    withImage();

    const report = await sync();

    expect(report.attachmentsDownloaded).toBe(1);
    expect(vault.binaries.has('ENG/_attachments/1/a.png')).toBe(true);
    expect(vault.files.get('ENG/A.md')).toContain('![[ENG/_attachments/1/a.png]]');
  });

  it('records the version so the next sync does not fetch it again (FR-8.3)', async () => {
    withImage();
    await sync();
    expect(client.downloaded).toEqual(['/download/a.png']);

    // Second sync, page unchanged: the attachment is already current.
    await sync();
    expect(client.downloaded).toEqual(['/download/a.png']);
  });

  it('fetches again when the attachment version moved', async () => {
    withImage();
    await sync();

    client.attachments.set('1', [
      {
        id: 'att1',
        filename: 'a.png',
        version: 4,
        size: 1024,
        downloadPath: '/download/a.png?v=4',
      },
    ]);
    client.pages = [{ id: '1', title: 'A', version: 2, storage: IMAGE }];
    await sync();

    expect(client.downloaded).toEqual(['/download/a.png', '/download/a.png?v=4']);
  });

  it('fetches again when the file is gone from the vault, whatever the index says', async () => {
    withImage();
    await sync();
    vault.binaries.delete('ENG/_attachments/1/a.png');

    client.pages = [{ id: '1', title: 'A', version: 2, storage: IMAGE }];
    await sync();

    expect(client.downloaded).toHaveLength(2);
  });

  it('skips an attachment over the size limit, and says why (FR-8.4)', async () => {
    withImage(30 * 1_048_576);

    const report = await sync();

    expect(client.downloaded).toEqual([]);
    expect(report.skippedAttachments[0]?.filename).toBe('a.png');
    expect(report.skippedAttachments[0]?.reason).toContain('limit');
    // Still readable as a placeholder rather than a broken embed.
    expect(vault.files.get('ENG/A.md')).toContain('{cf:');
  });

  it('downloads an attachment of unreported size rather than assuming the worst', async () => {
    // Refusing on a missing size would hide attachments for a whole instance.
    withImage(null);

    await sync();

    expect(client.downloaded).toEqual(['/download/a.png']);
  });

  it('ignores an attachment the body does not refer to (FR-8.5)', async () => {
    client.pages = [{ id: '1', title: 'A', storage: '<p>No images here.</p>' }];
    client.attachments.set('1', [
      { id: 'att1', filename: 'a.png', version: 1, size: 10, downloadPath: '/download/a.png' },
    ]);

    const report = await sync();

    expect(client.downloaded).toEqual([]);
    expect(report.attachmentsDownloaded).toBe(0);
  });

  it('writes the page even when the download fails (FR-3.9)', async () => {
    withImage();
    client.failDownload.add('/download/a.png');

    const report = await sync();

    expect(report.failures).toHaveLength(1);
    expect(vault.files.has('ENG/A.md')).toBe(true);
    expect(vault.files.get('ENG/A.md')).toContain('{cf:');
  });
});

describe('links between mirrored pages (FR-4.7)', () => {
  it('writes a wikilink to a page the same sync is placing', async () => {
    // The link resolves against the placement being made now, not the index being
    // replaced — on a first sync there is no index at all.
    client.pages = [
      {
        id: '1',
        title: 'Architecture',
        storage: '<p>See <ac:link><ri:page ri:content-title="Data Model"/></ac:link>.</p>',
      },
      { id: '2', title: 'Data Model', parentId: '1' },
    ];

    await sync();

    expect(vault.files.get('ENG/Architecture/Architecture.md')).toContain(
      '[[ENG/Architecture/Data Model]]',
    );
  });

  it('leaves a link to a page outside the mirror as a URL', async () => {
    client.pages = [
      {
        id: '1',
        title: 'Architecture',
        storage: '<p>See <ac:link><ri:page ri:content-title="Elsewhere"/></ac:link>.</p>',
      },
    ];

    await sync();
    const note = vault.files.get('ENG/Architecture.md') ?? '';

    expect(note).not.toContain('[[');
    expect(note).toContain('https://wiki.corp/display/ENG/Elsewhere');
  });
});

describe('first sync', () => {
  it('mirrors the subtree into the mount', async () => {
    client.pages = [
      { id: '1', title: 'Architecture' },
      { id: '2', title: 'Data Model', parentId: '1' },
    ];

    const report = await sync();

    expect(report.pulled).toBe(2);
    expect([...vault.files.keys()].sort()).toEqual([
      'ENG/Architecture/Architecture.md',
      'ENG/Architecture/Data Model.md',
    ]);
  });

  it('records what it wrote so the next sync can tell what changed', async () => {
    client.pages = [{ id: '1', title: 'A', version: 4 }];
    await sync();

    const page = state.forSubscription('sub').pages['1'];
    expect(page?.remoteVersion).toBe(4);
    expect(page?.localPath).toBe('ENG/A.md');
    expect(page?.localHash).toHaveLength(64);
    expect(state.forSubscription('sub').lastSyncedAt).toBe(NOW);
  });

  it('caches the placeholder fragments of every page it wrote (FR-4.3)', async () => {
    client.pages = [{ id: '1', title: 'A', storage: '<ac:structured-macro ac:name="toc"/>' }];
    await sync();

    expect(stateGateway.files.has('fragments/1.json')).toBe(true);
  });

  it('reports progress and finishes without being cancelled', async () => {
    client.pages = [{ id: '1', title: 'A' }];
    const seen: SyncProgress[] = [];

    const report = await sync({ onProgress: (progress) => seen.push(progress) });

    expect(seen.map((progress) => progress.phase)).toContain('discovering');
    expect(seen.map((progress) => progress.phase)).toContain('applying');
    expect(report.cancelled).toBe(false);
  });
});

describe('incremental sync', () => {
  beforeEach(async () => {
    client.pages = [{ id: '1', title: 'A' }];
    await sync();
    vault.writes.length = 0;
    client.fetched.length = 0;
  });

  it('writes nothing when nothing changed', async () => {
    const report = await sync();

    expect(report.unchanged).toBe(1);
    expect(report.pulled).toBe(0);
    expect(client.fetched).toHaveLength(0);
  });

  it('fetches only the page whose version moved on', async () => {
    client.pages = [
      { id: '1', title: 'A', version: 2 },
      { id: '2', title: 'B' },
    ];

    const report = await sync();

    expect(report.pulled).toBe(2);
    expect(client.fetched.sort()).toEqual(['1', '2']);
  });

  it('renames the note when the page is renamed remotely (FR-3.7)', async () => {
    client.pages = [{ id: '1', title: 'Renamed', version: 2 }];

    const report = await sync();

    expect(report.relocated).toBe(1);
    expect(vault.files.has('ENG/Renamed.md')).toBe(true);
    expect(vault.files.has('ENG/A.md')).toBe(false);
    expect(state.forSubscription('sub').pages['1']?.localPath).toBe('ENG/Renamed.md');
  });

  it('leaves a locally edited page untouched and reports it', async () => {
    vault.files.set('ENG/A.md', 'edited by hand\n');

    const report = await sync();

    expect(report.localEdits.map((page) => page.pageId)).toEqual(['1']);
    expect(vault.files.get('ENG/A.md')).toBe('edited by hand\n');
  });

  it('reports a conflict without writing when both sides changed', async () => {
    vault.files.set('ENG/A.md', 'edited by hand\n');
    client.pages = [{ id: '1', title: 'A', version: 2 }];

    const report = await sync();

    expect(report.conflicts.map((page) => page.pageId)).toEqual(['1']);
    expect(vault.files.get('ENG/A.md')).toBe('edited by hand\n');
  });
});

describe('remote deletions (FR-3.5)', () => {
  beforeEach(async () => {
    client.pages = [{ id: '1', title: 'A' }];
    await sync();
    client.pages = [];
  });

  it('keeps the note when the user declines', async () => {
    const report = await sync({ confirmDeletions: () => Promise.resolve(false) });

    expect(report.deleted).toBe(0);
    expect(vault.files.has('ENG/A.md')).toBe(true);
    // Still tracked, so the next sync offers the deletion again.
    expect(state.forSubscription('sub').pages['1']).toBeDefined();
  });

  it('never deletes when there is nobody to ask', async () => {
    const report = await sync();

    expect(report.deleted).toBe(0);
    expect(vault.files.has('ENG/A.md')).toBe(true);
  });

  it('trashes the note and forgets the page once confirmed', async () => {
    let shown: readonly LocalPage[] = [];
    const report = await sync({
      confirmDeletions: (pages) => {
        shown = pages;
        return Promise.resolve(true);
      },
    });

    expect(shown.map((page) => page.path)).toEqual(['ENG/A.md']);
    expect(report.deleted).toBe(1);
    expect(vault.trashed).toEqual(['ENG/A.md']);
    expect(state.forSubscription('sub').pages['1']).toBeUndefined();
  });

  it('forgets a page that is gone on both sides without asking', async () => {
    vault.files.delete('ENG/A.md');
    let asked = false;

    await sync({
      confirmDeletions: () => {
        asked = true;
        return Promise.resolve(true);
      },
    });

    expect(asked).toBe(false);
    expect(state.forSubscription('sub').pages['1']).toBeUndefined();
  });
});

describe('failure isolation (FR-3.9)', () => {
  it('keeps going when one page cannot be fetched', async () => {
    client.pages = [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ];
    client.failGetPage.add('1');

    const report = await sync();

    expect(report.pulled).toBe(1);
    expect(report.failures.map((entry) => entry.pageId)).toEqual(['1']);
    expect(vault.files.has('ENG/B.md')).toBe(true);
  });

  it('keeps going when one page cannot be written', async () => {
    client.pages = [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ];
    vault.failWrites.add('ENG/A.md');

    const report = await sync();

    expect(report.failures.map((entry) => entry.pageId)).toEqual(['1']);
    expect(report.pulled).toBe(1);
  });

  it('leaves a failed page untracked so the next sync retries it', async () => {
    client.pages = [{ id: '1', title: 'A' }];
    client.failGetPage.add('1');
    await sync();

    expect(state.forSubscription('sub').pages['1']).toBeUndefined();
  });
});

describe('fidelity', () => {
  it('writes a page that cannot round-trip and marks it degraded (FR-4.4)', async () => {
    // A thematic break carries no attributes in Markdown, so the border cannot be
    // reproduced and the page can never be pushed safely. A `class` would no
    // longer do: §6.4.6 drops those, precisely so they stop costing pages a push.
    client.pages = [
      { id: '1', title: 'A', storage: '<p>a</p><hr style="border-top: 1px solid red;"/>' },
    ];

    const report = await sync();

    expect(report.degraded.map((page) => page.pageId)).toEqual(['1']);
    expect(vault.files.has('ENG/A.md')).toBe(true);
    expect(state.forSubscription('sub').pages['1']?.fidelity).toBe('degraded');
  });
});

describe('cancellation (FR-3.4)', () => {
  it('stops between batches and leaves what it wrote consistent', async () => {
    client.pages = Array.from({ length: 8 }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${String(index + 1)}`,
    }));

    let calls = 0;
    const report = await sync({
      isCancelled: () => {
        calls += 1;
        return calls > 1;
      },
    });

    expect(report.cancelled).toBe(true);
    expect(report.pulled).toBeLessThan(8);
    expect(Object.keys(state.forSubscription('sub').pages)).toHaveLength(report.pulled);
  });
});

describe('preflight', () => {
  it('suspends the connection after an authentication failure (FR-1.8)', async () => {
    client.connectionError = new AppError('AUTH_FAILED', 'Token rejected.');

    const failed = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(!failed.ok && failed.error.code).toBe('AUTH_FAILED');
    expect(suspensions.get('conn')?.reason).toBe('Token rejected.');
  });

  it('refuses to run again while suspended, without calling Confluence', async () => {
    suspensions.suspend('conn', 'Token rejected.', NOW);

    const failed = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(!failed.ok && failed.error.code).toBe('AUTH_FAILED');
    expect(client.fetched).toHaveLength(0);
  });

  it('blocks a server too old for Personal Access Tokens (FR-1.7)', async () => {
    client.versionSupported = false;

    const failed = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(!failed.ok && failed.error.code).toBe('VERSION_UNSUPPORTED');
    expect(vault.files.size).toBe(0);
  });

  it('does not suspend on a failure that might pass next time', async () => {
    client.listError = new AppError('NETWORK_UNREACHABLE', 'VPN is down.');

    const failed = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(failed.ok).toBe(false);
    expect(suspensions.get('conn')).toBeNull();
  });

  it('aborts when the mount cannot be scanned', async () => {
    Object.defineProperty(vault, 'scan', {
      value: () => Promise.resolve({ ok: false, error: new AppError('OUT_OF_MOUNT', 'no') }),
    });

    const failed = await engine.sync({
      subscription: SUBSCRIPTION,
      client,
      baseUrl: 'https://wiki.corp',
      strictMarkup: false,
      ...LIMITS,
    });

    expect(!failed.ok && failed.error.code).toBe('OUT_OF_MOUNT');
  });
});

describe('reporting', () => {
  it('names untracked notes found in the mount', async () => {
    client.pages = [{ id: '1', title: 'A' }];
    vault.addForeignNote('ENG/My own notes.md', 'personal\n');

    const report = await sync(acceptDeletions);

    expect(report.untracked).toEqual(['ENG/My own notes.md']);
  });

  it('names pages whose file name had to be shortened', async () => {
    vault.vaultLength = 200;
    client.pages = [{ id: '8061060', title: 'x'.repeat(120) }];

    const report = await sync();

    expect(report.truncated.map((page) => page.pageId)).toEqual(['8061060']);
  });

  it('names pages it could not place at all', async () => {
    vault.vaultLength = 300;
    client.pages = [{ id: '1', title: 'A' }];

    const report = await sync();

    expect(report.unmappable).toHaveLength(1);
    expect(report.pulled).toBe(0);
  });

  it('reports a note the user deleted as an orphan, never deleting remotely (D6)', async () => {
    client.pages = [{ id: '1', title: 'A' }];
    await sync();
    vault.files.delete('ENG/A.md');

    const report = await sync();

    expect(report.orphans.map((page) => page.pageId)).toEqual(['1']);
    expect(client.pages).toHaveLength(1);
  });
});
