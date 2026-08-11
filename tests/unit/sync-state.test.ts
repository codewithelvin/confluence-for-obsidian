import { describe, expect, it } from 'vitest';
import { FragmentStore } from '../../src/sync/fragment-store';
import { SyncStateStore, emptyIndex, parseIndex, type PageState } from '../../src/sync/sync-state';
import { SuspensionRegistry, isSuspendingError } from '../../src/sync/suspension';
import { AppError } from '../../src/util/errors';
import type { Fragment } from '../../src/convert/types';
import { FakeStateGateway } from '../fakes/sync';

const PAGE: PageState = {
  pageId: '1',
  title: 'A',
  parentId: null,
  remoteVersion: 3,
  localPath: 'Confluence/ENG/A.md',
  isFolderNote: false,
  alias: null,
  attachments: {},
  localHash: 'local',
  storageHash: 'storage',
  fidelity: 'certified',
  lastSyncedAt: '2026-08-10T12:00:00Z',
};

describe('parseIndex', () => {
  it('reads back what the store wrote', () => {
    const index = {
      schemaVersion: 1,
      subscriptions: { sub: { lastSyncedAt: '2026-08-10T12:00:00Z', pages: { '1': PAGE } } },
    };

    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
  });

  it('degrades unusable input to an empty index rather than throwing', () => {
    expect(parseIndex(null)).toEqual(emptyIndex());
    expect(parseIndex('nonsense')).toEqual(emptyIndex());
    expect(parseIndex({ subscriptions: 'nonsense' })).toEqual(emptyIndex());
  });

  it('drops a page record it cannot read, leaving the rest usable', () => {
    // The dropped page is simply pulled again, which is always safe.
    const parsed = parseIndex({
      subscriptions: { sub: { pages: { '1': PAGE, '2': { title: 'no id' } } } },
    });

    expect(Object.keys(parsed.subscriptions['sub']?.pages ?? {})).toEqual(['1']);
  });

  it('defaults a missing folder-note flag to false', () => {
    const parsed = parseIndex({
      subscriptions: { sub: { pages: { '1': { pageId: '1', localPath: 'a.md' } } } },
    });

    expect(parsed.subscriptions['sub']?.pages['1']?.isFolderNote).toBe(false);
  });
});

describe('SyncStateStore', () => {
  it('starts empty when nothing has been written', async () => {
    const store = new SyncStateStore(new FakeStateGateway());
    await store.load();

    expect(store.get()).toEqual(emptyIndex());
    expect(store.forSubscription('sub').pages).toEqual({});
  });

  it('persists and reloads a subscription', async () => {
    const state = new FakeStateGateway();
    const store = new SyncStateStore(state);
    await store.load();
    await store.replace('sub', { lastSyncedAt: '2026-08-10T12:00:00Z', pages: { '1': PAGE } });

    const reloaded = new SyncStateStore(state);
    await reloaded.load();

    expect(reloaded.forSubscription('sub').pages['1']).toEqual(PAGE);
  });

  it('starts empty rather than failing on a corrupt index', async () => {
    const state = new FakeStateGateway();
    await state.write('index.json', '{ this is not json');

    const store = new SyncStateStore(state);
    expect((await store.load()).ok).toBe(true);
    expect(store.get()).toEqual(emptyIndex());
  });

  it('reports a read failure from the state gateway', async () => {
    const state = new FakeStateGateway();
    Object.defineProperty(state, 'read', {
      value: () => Promise.resolve({ ok: false, error: new AppError('VAULT_WRITE_FAILED', 'no') }),
    });

    expect((await new SyncStateStore(state).load()).ok).toBe(false);
  });

  it('forgets a subscription without touching the others', async () => {
    const store = new SyncStateStore(new FakeStateGateway());
    await store.load();
    await store.replace('a', { lastSyncedAt: null, pages: { '1': PAGE } });
    await store.replace('b', { lastSyncedAt: null, pages: { '1': PAGE } });

    await store.forget('a');

    expect(Object.keys(store.get().subscriptions)).toEqual(['b']);
  });

  it('reports a failed write', async () => {
    const state = new FakeStateGateway();
    const store = new SyncStateStore(state);
    await store.load();
    state.failWrites = true;

    expect((await store.replace('sub', { lastSyncedAt: null, pages: {} })).ok).toBe(false);
  });
});

const FRAGMENT: Fragment = {
  id: 'cfb-0001',
  kind: 'block',
  xhtml: '<ac:structured-macro ac:name="jira"/>',
  type: 'macro',
  name: 'jira',
  label: 'Jira issues',
};

describe('FragmentStore', () => {
  it('round-trips a fragment set', async () => {
    const state = new FakeStateGateway();
    const store = new FragmentStore(state);
    await store.save('123', 'storage-hash', new Map([[FRAGMENT.id, FRAGMENT]]));

    const loaded = await store.load('123');
    expect(loaded.ok && loaded.value?.storageHash).toBe('storage-hash');
    expect(loaded.ok && loaded.value?.fragments.get('cfb-0001')).toEqual(FRAGMENT);
  });

  it('reports no cache for a page that was never pulled', async () => {
    const loaded = await new FragmentStore(new FakeStateGateway()).load('123');
    expect(loaded.ok && loaded.value).toBeNull();
  });

  it('treats a tampered cache as absent (spec FR-4.3)', async () => {
    // Pushing a body reassembled from fragments that may have been altered is
    // exactly what decision D3 exists to prevent, so a failed integrity check
    // forces a re-pull instead.
    const state = new FakeStateGateway();
    const store = new FragmentStore(state);
    await store.save('123', 'storage-hash', new Map([[FRAGMENT.id, FRAGMENT]]));

    const name = 'fragments/123.json';
    const stored = state.files.get(name) ?? '';
    state.files.set(name, stored.replace('jira', 'evil'));

    const loaded = await store.load('123');
    expect(loaded.ok && loaded.value).toBeNull();
  });

  it('treats an unreadable cache as absent', async () => {
    const state = new FakeStateGateway();
    await state.write('fragments/123.json', 'not json');
    await state.write('fragments/124.json', '{"fragments":[{"kind":"inline"}]}');

    const store = new FragmentStore(state);
    expect((await store.load('123')).ok && (await store.load('123')).ok).toBe(true);
    expect((await store.load('124')).ok).toBe(true);
    expect(((await store.load('124')) as { value: unknown }).value).toBeNull();
  });

  it('never lets a page id escape the state folder', async () => {
    const state = new FakeStateGateway();
    await new FragmentStore(state).save('../../evil', 'h', new Map());

    expect([...state.files.keys()]).toEqual(['fragments/______evil.json']);
  });

  it('removes a cache', async () => {
    const state = new FakeStateGateway();
    const store = new FragmentStore(state);
    await store.save('123', 'h', new Map([[FRAGMENT.id, FRAGMENT]]));

    await store.remove('123');
    expect((await store.load('123')).ok).toBe(true);
    expect(state.files.size).toBe(0);
  });
});

describe('SuspensionRegistry', () => {
  it('classifies which failures should stop sync (spec FR-1.8)', () => {
    expect(isSuspendingError(new AppError('AUTH_FAILED', 'x'))).toBe(true);
    expect(isSuspendingError(new AppError('VERSION_UNSUPPORTED', 'x'))).toBe(true);
    expect(isSuspendingError(new AppError('NETWORK_UNREACHABLE', 'x'))).toBe(false);
    expect(isSuspendingError(new AppError('RATE_LIMITED', 'x'))).toBe(false);
  });

  it('holds and clears a suspension, notifying listeners', () => {
    const registry = new SuspensionRegistry();
    let changes = 0;
    const stop = registry.onChange(() => {
      changes += 1;
    });

    registry.suspend('conn', 'token revoked', '2026-08-10T12:00:00Z');
    expect(registry.get('conn')?.reason).toBe('token revoked');
    expect(registry.all()).toHaveLength(1);

    registry.clear('conn');
    expect(registry.get('conn')).toBeNull();
    expect(changes).toBe(2);

    stop();
    registry.suspend('conn', 'again', '2026-08-10T12:00:00Z');
    expect(changes).toBe(2);
  });

  it('ignores clearing a connection that was never suspended', () => {
    const registry = new SuspensionRegistry();
    let changes = 0;
    registry.onChange(() => {
      changes += 1;
    });

    registry.clear('conn');
    expect(changes).toBe(0);
  });
});
