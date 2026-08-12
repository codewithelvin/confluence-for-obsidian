import { beforeEach, describe, expect, it } from 'vitest';
import { parseCommentRef } from '../../src/api/api-types';
import { COMMENT_WINDOW_HOURS, commentsChangedCql, cqlDateTime } from '../../src/api/cql';
import type { Subscription } from '../../src/settings/settings-types';
import { FragmentStore } from '../../src/sync/fragment-store';
import { pagesWithNewComments } from '../../src/sync/sync-discovery';
import { SyncEngine } from '../../src/sync/sync-engine';
import { SyncStateStore } from '../../src/sync/sync-state';
import { SuspensionRegistry } from '../../src/sync/suspension';
import type { SyncReport } from '../../src/sync/sync-types';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway, fakeBackups } from '../fakes/sync';

/**
 * A comment on an otherwise unchanged page (§16 O16).
 *
 * FR-9.4 rebuilds the comments region as part of writing a body, and FR-3.3 fetches
 * a body only where the version moved — so before this, a colleague who commented
 * without editing changed nothing the sync looked at, and the remark never arrived.
 * One CQL query per subscription buys the whole space.
 */

const FIRST = '2026-08-10T12:00:00Z';
const SECOND = '2026-08-11T12:00:00Z';
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
let state: SyncStateStore;
let client: FakeConfluence;
let now: string;
let engine: SyncEngine;

beforeEach(async () => {
  vault = new FakeVaultGateway();
  const stateGateway = new FakeStateGateway();
  state = new SyncStateStore(stateGateway);
  client = new FakeConfluence();
  client.pages = [{ id: '1', title: 'Architecture' }];
  now = FIRST;

  await state.load();
  engine = new SyncEngine({
    vault,
    state,
    fragments: new FragmentStore(stateGateway),
    backups: fakeBackups(stateGateway),
    suspensions: new SuspensionRegistry(),
    logger: new Logger('test', () => false),
    now: () => now,
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

/** How many times the note was written, which is what "was it pulled" means here. */
function writes(path = 'ENG/Architecture.md'): number {
  return vault.noteWrites.filter((candidate) => candidate.path === path).length;
}

describe('the change query itself', () => {
  it('reaches back far enough to survive an unknown server timezone', () => {
    expect(cqlDateTime('2026-08-11T12:00:00.000Z', COMMENT_WINDOW_HOURS)).toBe('2026-08-10 12:00');
  });

  it('formats a date CQL accepts, to the minute', () => {
    expect(cqlDateTime('2026-08-11T12:34:56.789Z', 0)).toBe('2026-08-11 12:34');
  });

  it('answers nothing for a timestamp it cannot read', () => {
    expect(cqlDateTime('not a date', 0)).toBeNull();
  });

  it('quotes the space key and the date', () => {
    expect(commentsChangedCql('ENG', '2026-08-10 12:00')).toBe(
      'space = "ENG" AND type = comment AND lastModified >= "2026-08-10 12:00"',
    );
  });

  it('reads the page a comment belongs to out of its container', () => {
    const parsed = parseCommentRef({
      id: '99',
      container: { id: '1' },
      version: { when: '2026-08-11T13:00:00.000+04:00' },
    });

    expect(parsed.ok && parsed.value).toEqual({
      id: '99',
      pageId: '1',
      updatedAt: '2026-08-11T13:00:00.000+04:00',
    });
  });

  it('refuses a comment whose page is not named', () => {
    expect(parseCommentRef({ id: '99' }).ok).toBe(false);
  });
});

describe('pagesWithNewComments', () => {
  const ref = (pageId: string, updatedAt: string) => ({ id: `c-${pageId}`, pageId, updatedAt });

  it('keeps only comments later than the last sync', () => {
    const pages = pagesWithNewComments(
      [ref('1', '2026-08-11T13:00:00Z'), ref('2', '2026-08-11T11:00:00Z')],
      SECOND,
    );

    expect([...pages]).toEqual(['1']);
  });

  it('compares instants, not text, so a server offset cannot mislead it', () => {
    // 13:00+04:00 is 09:00Z — before the cutoff, though it sorts after it as a string.
    expect([...pagesWithNewComments([ref('1', '2026-08-11T13:00:00+04:00')], SECOND)]).toEqual([]);
  });

  it('keeps a comment whose timestamp the instance did not report', () => {
    expect([...pagesWithNewComments([ref('1', '')], SECOND)]).toEqual(['1']);
  });

  it('answers nothing when the last sync time is unreadable', () => {
    expect([...pagesWithNewComments([ref('1', SECOND)], 'nonsense')]).toEqual([]);
  });
});

describe('a sync that finds a new comment', () => {
  it('pulls a page whose body never moved', async () => {
    await sync();
    expect(writes()).toBe(1);

    now = SECOND;
    client.changedComments = [{ id: '99', pageId: '1', updatedAt: SECOND }];

    const report = await sync();

    expect(writes()).toBe(2);
    expect(report.pulled).toBe(1);
    expect(report.unchanged).toBe(0);
  });

  it('asks once per sync, from the last sync time', async () => {
    await sync();
    now = SECOND;
    await sync();

    expect(client.commentQueries).toEqual([{ spaceKey: 'ENG', since: FIRST }]);
  });

  it('leaves the page alone when the comment is older than the last sync', async () => {
    await sync();
    now = SECOND;
    client.changedComments = [{ id: '99', pageId: '1', updatedAt: '2026-08-10T09:00:00Z' }];

    const report = await sync();

    expect(writes()).toBe(1);
    expect(report.unchanged).toBe(1);
  });

  it('never overwrites a note the user has edited', async () => {
    await sync();
    now = SECOND;
    vault.files.set('ENG/Architecture.md', 'my own work in progress');
    client.changedComments = [{ id: '99', pageId: '1', updatedAt: SECOND }];

    const report = await sync();

    expect(writes()).toBe(1);
    expect(report.localEdits.map((edit) => edit.pageId)).toEqual(['1']);
  });

  it('does not turn a remark into a conflict', async () => {
    // FR-6.1: a conflict is a local edit against a moved remote version. A comment
    // moves no version, and interrupting the user to resolve one would be a lie.
    await sync();
    now = SECOND;
    vault.files.set('ENG/Architecture.md', 'my own work in progress');
    client.changedComments = [{ id: '99', pageId: '1', updatedAt: SECOND }];

    expect((await sync()).conflicts).toHaveLength(0);
  });
});

describe('when the query cannot run', () => {
  it('is skipped on a first sync, where every page is pulled anyway', async () => {
    await sync();

    expect(client.commentQueries).toEqual([]);
  });

  it('is skipped where the subscription has comments switched off (FR-9.5)', async () => {
    const quiet: Subscription = { ...SUBSCRIPTION, syncComments: false };
    await sync(quiet);
    now = SECOND;
    await sync(quiet);

    expect(client.commentQueries).toEqual([]);
  });

  it('leaves the sync exactly as it was when the server refuses it', async () => {
    await sync();
    now = SECOND;
    client.changedCommentsError = new AppError('UNKNOWN', 'CQL not supported here');

    const report = await sync();

    expect(report.unchanged).toBe(1);
    expect(writes()).toBe(1);
  });
});
