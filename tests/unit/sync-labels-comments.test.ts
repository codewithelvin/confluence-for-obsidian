import { beforeEach, describe, expect, it } from 'vitest';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { COMMENTS_BEGIN, COMMENTS_END } from '../../src/sync/managed-regions';
import { SyncEngine } from '../../src/sync/sync-engine';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import type { SyncReport } from '../../src/sync/sync-types';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * A sync that carries labels and comments (spec FR-9.1, FR-9.3 to FR-9.6).
 *
 * End to end through the engine rather than against the executor, because the
 * question these answer is a wiring one: the labels have to reach `writeNote` as
 * the tags the plugin owns, and the region has to reach the note *after*
 * conversion and outside certification.
 */

const NOW = '2026-08-10T12:00:00Z';
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
let client: FakeConfluence;
let engine: SyncEngine;

function comment(id: string, author: string, text: string, inlineRef: string | null = null) {
  return {
    id,
    author,
    createdAt: '2026-08-09T14:03:11Z',
    storage: `<p>${text}</p>`,
    location: inlineRef === null ? ('footer' as const) : ('inline' as const),
    inlineRef,
  };
}

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  client.pages = [{ id: '1', title: 'Architecture' }];

  await state.load();
  engine = new SyncEngine({
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    suspensions: new SuspensionRegistry(),
    logger: new Logger('test', () => false),
    now: () => NOW,
  });
});

async function sync(subscription: Subscription = SUBSCRIPTION): Promise<SyncReport> {
  const result = await engine.sync({
    subscription,
    client,
    baseUrl: 'https://wiki.corp',
    strictMarkup: false,
    ...LIMITS,
  });
  if (!result.ok) throw new Error(`sync failed: ${result.error.userMessage}`);
  return result.value;
}

function lastWrite(path = 'ENG/Architecture.md') {
  const write = vault.noteWrites.filter((candidate) => candidate.path === path).at(-1);
  if (write === undefined) throw new Error(`nothing was written to ${path}`);
  return write;
}

describe('labels become tags (FR-9.1)', () => {
  it('writes the page’s labels as the tags the plugin owns', async () => {
    client.labels.set('1', ['api', 'architecture']);

    await sync();

    expect(lastWrite().tags).toEqual(['api', 'architecture']);
    expect(lastWrite().previousTags).toEqual([]);
  });

  it('records them, so the next sync knows which tags are its own', async () => {
    client.labels.set('1', ['api']);
    await sync();

    expect(state.forSubscription('sub').pages['1']?.labels).toEqual(['api']);
  });

  it('offers last sync’s labels as the only tags it may remove', async () => {
    client.labels.set('1', ['api', 'gone']);
    await sync();

    // A second sync of a changed page: the label has gone remotely, and the write
    // has to name it as removable without touching anything else in `tags`.
    client.labels.set('1', ['api']);
    client.pages = [{ id: '1', title: 'Architecture', version: 2, storage: '<p>changed</p>' }];
    await sync();

    expect(lastWrite().tags).toEqual(['api']);
    expect(lastWrite().previousTags).toEqual(['api', 'gone']);
  });

  it('writes no tags for a page with no labels', async () => {
    await sync();
    expect(lastWrite().tags).toEqual([]);
  });
});

describe('the comments region (FR-9.3 to FR-9.6)', () => {
  it('appends the region to the note and counts it in the report', async () => {
    client.comments.set('1', [comment('c1', 'j.smith', 'Looks good.')]);

    const report = await sync();
    const body = lastWrite().body;

    expect(body).toContain(COMMENTS_BEGIN);
    expect(body).toContain('> **j.smith** — 2026-08-09 14:03');
    expect(body).toContain('> Looks good.');
    expect(body.trimEnd().endsWith(COMMENTS_END)).toBe(true);
    expect(report.commentsPulled).toBe(1);
    expect(report.commentRegions).toBe(1);
  });

  it('keeps the region out of the converted body, so it cannot affect certification', async () => {
    client.comments.set('1', [comment('c1', 'j.smith', 'Looks good.')]);

    await sync();

    // The page is certified on its *storage*, and the region is not part of it.
    expect(state.forSubscription('sub').pages['1']?.fidelity).toBe('certified');
    expect(lastWrite().body.startsWith('body')).toBe(true);
  });

  it('names the anchor of an inline comment', async () => {
    client.comments.set('1', [comment('c1', 'j.smith', 'This sentence.', 'ref-7')]);

    await sync();
    expect(lastWrite().body).toContain('(on ref-7)');
  });

  it('writes no region for a page nobody has commented on', async () => {
    const report = await sync();

    expect(lastWrite().body).not.toContain(COMMENTS_BEGIN);
    expect(report.commentRegions).toBe(0);
  });

  it('writes no region at all when the subscription has comments off (FR-9.5)', async () => {
    client.comments.set('1', [comment('c1', 'j.smith', 'Looks good.')]);

    await sync({ ...SUBSCRIPTION, syncComments: false });

    expect(lastWrite().body).not.toContain(COMMENTS_BEGIN);
  });

  it('honours one note’s opt-out with the subscription still on (FR-9.6, §16 O5)', async () => {
    client.comments.set('1', [comment('c1', 'j.smith', 'Looks good.')]);
    vault.commentsOptOut.add('ENG/Architecture.md');

    await sync();

    expect(lastWrite().body).not.toContain(COMMENTS_BEGIN);
  });

  it('still writes the page when the comments cannot be fetched (FR-3.9)', async () => {
    client.commentError = new AppError('NETWORK_UNREACHABLE', 'no route');

    const report = await sync();

    expect(vault.files.has('ENG/Architecture.md')).toBe(true);
    expect(report.failures).toHaveLength(1);
    expect(report.pulled).toBe(1);
  });
});
