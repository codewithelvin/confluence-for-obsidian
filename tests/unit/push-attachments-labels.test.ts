import { beforeEach, describe, expect, it } from 'vitest';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import { FragmentStore } from '../../src/sync/fragment-store';
import { pushPage, type PushDeps, type PushOutcome } from '../../src/sync/push-executor';
import type { PageState } from '../../src/sync/sync-state';
import { AppError } from '../../src/util/errors';
import { sha256 } from '../../src/util/hash';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';

/**
 * Uploading embedded files and applying label changes on push (FR-8.6, FR-9.2).
 *
 * Two invariants, and every test here is about one of them:
 *
 *  - **nothing is uploaded for a page that is not going to be written.** FR-8.7
 *    forbids the plugin ever deleting an attachment, so a file sent for a push that
 *    was then refused stays on the page forever.
 *  - **a label is metadata.** Failing to apply one must not report the page as
 *    unpublished, and must not be silent either.
 */

const NOW = '2026-08-11T09:00:00Z';
const BODY = '<p>The original body.</p>';
const NOTE = 'ENG/Architecture.md';
const IMAGE = 'ENG/_attachments/1/diagram.png';

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let fragments: FragmentStore;
let client: FakeConfluence;
let deps: PushDeps;

function pageState(extra: Partial<PageState> = {}): PageState {
  return {
    pageId: '1',
    title: 'Architecture',
    parentId: '900',
    remoteVersion: 4,
    localPath: NOTE,
    isFolderNote: false,
    alias: null,
    attachments: {},
    localHash: 'stale',
    storageHash: 'storage',
    fidelity: 'certified',
    lastSyncedAt: '2026-08-10T12:00:00Z',
    labels: [],
    ...extra,
  };
}

/** The note and fragment cache as a completed pull would leave them. */
async function seed(bodyMarkdown?: string): Promise<void> {
  const converted = storageToMarkdown(BODY, { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' });
  if (!converted.ok) throw new Error('fixture does not convert');

  const markdown = bodyMarkdown ?? converted.value.markdown;
  vault.files.set(NOTE, `---\nconfluence:\n  id: 1\n---\n${markdown}`);
  await fragments.save('1', await sha256(BODY), converted.value.fragments);
}

beforeEach(() => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  fragments = new FragmentStore(stateGateway);
  client = new FakeConfluence();
  client.pages = [{ id: '1', title: 'Architecture', version: 4, storage: BODY }];

  deps = {
    client,
    vault,
    fragments,
    logger: new Logger('test', () => false),
    baseUrl: 'https://wiki.corp',
    spaceKey: 'ENG',
    strictMarkup: false,
    resolveTarget: () => null,
    resolveVaultPath: () => null,
    resolvePageId: () => null,
    now: () => NOW,
  };
});

function push(state = pageState(), options = {}): Promise<PushOutcome> {
  return pushPage(deps, { state, spaceKey: 'ENG' }, options);
}

describe('uploading a file the note embeds (FR-8.6)', () => {
  beforeEach(async () => {
    vault.binaries.set(IMAGE, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await seed(`An edited body.\n\n![[${IMAGE}]]\n`);
  });

  it('uploads the file and writes an attachment reference for it', async () => {
    const outcome = await push();

    expect(outcome.kind).toBe('pushed');
    expect(client.uploads).toEqual([{ pageId: '1', filename: 'diagram.png', bytes: 4 }]);
    // The point of uploading: the body Confluence receives refers to the attachment
    // rather than carrying the embed as literal text.
    expect(client.updates[0]?.storage).toContain('<ri:attachment ri:filename="diagram.png"/>');
  });

  it('records the attachment so the next pull does not fetch it back', async () => {
    const outcome = await push();
    if (outcome.kind !== 'pushed') throw new Error('expected a push');

    expect(outcome.state.attachments['diagram.png']).toEqual({
      id: 'att-diagram.png',
      version: 1,
      localPath: IMAGE,
    });
  });

  it('uploads nothing for a page a gate refuses', async () => {
    // The upload runs after every gate for exactly this reason: FR-8.7 means an
    // upload for a push that never happened can never be tidied up.
    const outcome = await push(pageState({ fidelity: 'degraded' }));

    expect(outcome.kind).toBe('blocked');
    expect(client.uploads).toEqual([]);
    expect(client.updates).toEqual([]);
  });

  it('uploads nothing when the remote has moved on', async () => {
    client.pages = [{ id: '1', title: 'Architecture', version: 9, storage: '<p>Theirs.</p>' }];

    const outcome = await push();

    expect(outcome.kind).toBe('conflict');
    expect(client.uploads).toEqual([]);
  });

  it('stops the push when an upload fails, rather than publishing a broken embed', async () => {
    client.uploadError = new AppError('NETWORK_UNREACHABLE', 'no route');

    const outcome = await push();

    expect(outcome.kind).toBe('blocked');
    expect(client.updates).toEqual([]);
  });

  it('does not upload a file already recorded as this page’s attachment', async () => {
    const state = pageState({
      attachments: { 'diagram.png': { id: 'att0', version: 2, localPath: IMAGE } },
    });

    await push(state);
    expect(client.uploads).toEqual([]);
  });

  it('refuses a name Confluence already holds instead of replacing that file', async () => {
    // `POST child/attachment` creates and does not replace — a repeated name answers
    // 400 — and this name is missing from the recorded state precisely because the
    // plugin did not put it there. Re-versioning it would change the picture for every
    // other page embedding it, and FR-8.7 means it could never be put back.
    client.attachments.set('1', [
      {
        id: 'att-theirs',
        filename: 'diagram.png',
        version: 3,
        size: 99,
        downloadPath: '/download/attachments/1/diagram.png',
      },
    ]);

    const outcome = await push();

    expect(outcome.kind).toBe('blocked');
    expect(client.uploads).toEqual([]);
    expect(client.updates).toEqual([]);
  });

  it('names both the attachment and the local file when it refuses', async () => {
    client.attachments.set('1', [
      {
        id: 'att-theirs',
        filename: 'diagram.png',
        version: 3,
        size: 99,
        downloadPath: '/download/attachments/1/diagram.png',
      },
    ]);

    const outcome = await push();
    if (outcome.kind !== 'blocked') throw new Error('expected the push to be blocked');

    expect(outcome.blocked.error.userMessage).toContain('diagram.png');
    expect(outcome.blocked.error.userMessage).toContain(IMAGE);
  });
});

describe('embeds that cannot be uploaded (FR-8.6)', () => {
  it('refuses an embed that resolves to nothing', async () => {
    await seed('An edited body.\n\n![[missing.png]]\n');

    const outcome = await push();

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.blocked.error.code).toBe('NOT_FOUND');
    expect(client.uploads).toEqual([]);
  });

  it('refuses a file whose name is already a different attachment on the page', async () => {
    // Confluence would file it as a new *version* of the existing attachment, so
    // every other page embedding that name would silently change picture.
    vault.binaries.set('ENG/_attachments/1/diagram.png', new Uint8Array([1]));
    await seed('An edited body.\n\n![[ENG/_attachments/1/diagram.png]]\n');

    const outcome = await push(
      pageState({
        attachments: {
          'diagram.png': { id: 'att0', version: 1, localPath: 'Other/diagram.png' },
        },
      }),
    );

    expect(outcome.kind).toBe('blocked');
    expect(client.uploads).toEqual([]);
  });

  it('never uploads an embedded note — a transclusion is not an attachment', async () => {
    // Uploading it would attach a `.md` file to the page and write an image
    // reference where Obsidian shows another note's contents. Confluence has no
    // form for a transclusion at all, so the verification gate refuses the push —
    // which is FR-5.2 doing its job, not FR-8.6 failing at it.
    vault.files.set('ENG/Other.md', 'Another note.');
    await seed('An edited body.\n\n![[ENG/Other.md]]\n');

    const outcome = await push();

    expect(client.uploads).toEqual([]);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.blocked.error.code).toBe('VERIFICATION_FAILED');
  });

  it('costs nothing for the great majority of notes, which embed nothing', async () => {
    await seed('An edited body.\n');

    expect((await push()).kind).toBe('pushed');
    expect(client.uploads).toEqual([]);
  });
});

describe('applying tag changes as labels (FR-9.2)', () => {
  beforeEach(async () => {
    await seed('An edited body.\n');
  });

  it('adds a label for a tag the user typed', async () => {
    vault.tags.set(NOTE, ['architecture']);

    const outcome = await push();

    expect(client.labelCalls).toEqual([{ kind: 'add', names: ['architecture'] }]);
    expect(outcome.kind === 'pushed' && outcome.state.labels).toEqual(['architecture']);
  });

  it('removes a label whose tag the user deleted', async () => {
    vault.tags.set(NOTE, []);

    const outcome = await push(pageState({ labels: ['architecture'] }));

    expect(client.labelCalls).toEqual([{ kind: 'remove', names: ['architecture'] }]);
    expect(outcome.kind === 'pushed' && outcome.state.labels).toEqual([]);
  });

  it('makes no label call when the tags have not changed', async () => {
    vault.tags.set(NOTE, ['api']);

    await push(pageState({ labels: ['api'] }));
    expect(client.labelCalls).toEqual([]);
  });

  it('reports a tag Confluence cannot hold, and still publishes the page', async () => {
    vault.tags.set(NOTE, ['two words']);

    const outcome = await push();

    expect(outcome.kind).toBe('pushed');
    if (outcome.kind !== 'pushed') return;
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.code).toBe('LABEL_UNSUPPORTED');
    expect(outcome.warnings[0]?.userMessage).toContain('"two words"');
    expect(client.labelCalls).toEqual([]);
  });

  it('reports a label call that failed without calling the push blocked', async () => {
    vault.tags.set(NOTE, ['architecture']);
    client.labelError = new AppError('PERMISSION_DENIED', 'not allowed to label');

    const outcome = await push();

    expect(outcome.kind).toBe('pushed');
    if (outcome.kind !== 'pushed') return;
    expect(outcome.warnings.map((error) => error.code)).toEqual(['PERMISSION_DENIED']);
    // The record must not claim a label the page does not have, or the next push
    // would never try again.
    expect(outcome.state.labels).toEqual([]);
    expect(client.updates).toHaveLength(1);
  });

  it('keeps the labels that did apply when a later removal fails', async () => {
    vault.tags.set(NOTE, []);
    const state = pageState({ labels: ['first', 'second'] });

    // Fails on the very first removal, so nothing was removed.
    client.labelError = new AppError('NETWORK_UNREACHABLE', 'no route');
    const outcome = await push(state);

    expect(outcome.kind === 'pushed' && outcome.state.labels).toEqual(['first', 'second']);
  });
});

describe('a push with nothing new to say (FR-9.2, §6.4.5)', () => {
  it('applies the labels without adding a version to the page’s history', async () => {
    // The common shape once tags are in play: the user changed a tag and nothing
    // else. A `PUT` would write a version whose diff is empty.
    await seed();
    vault.tags.set(NOTE, ['architecture']);

    const outcome = await push();

    expect(outcome.kind).toBe('pushed');
    expect(client.updates).toEqual([]);
    expect(client.labelCalls).toEqual([{ kind: 'add', names: ['architecture'] }]);
    expect(outcome.kind === 'pushed' && outcome.state.remoteVersion).toBe(4);
  });

  it('still writes the body when the remote has moved and the user chose Keep Local', async () => {
    // Byte-identical to what *was* pulled is not byte-identical to what the page
    // now holds: skipping here would leave a colleague's edit in place after the
    // user asked to publish theirs over it.
    await seed();
    client.pages = [{ id: '1', title: 'Architecture', version: 9, storage: '<p>Theirs.</p>' }];

    const outcome = await push(pageState(), { ontoVersion: 9 });

    expect(outcome.kind).toBe('pushed');
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]?.version).toBe(10);
  });
});

describe('an embed written as a bare file name (FR-8.2, FR-8.6)', () => {
  it('refuses it, and says what to write instead', async () => {
    // Obsidian's own autocomplete inserts a bare name when it is unique, so a user
    // will write this. FR-8.2 makes the full vault path the canonical form, and it is
    // the only one that survives the round trip — the reverse pass rebuilds the embed
    // from the recorded path. Refused with the path to use, rather than four steps
    // later as a verification diff about square brackets.
    vault.binaries.set(IMAGE, new Uint8Array([1, 2]));
    vault.embedTargets.set('diagram.png', IMAGE);
    await seed('An edited body.\n\n![[diagram.png]]\n');

    const outcome = await push();

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.blocked.error.code).toBe('EMBED_UNSUPPORTED');
    expect(outcome.blocked.error.userMessage).toContain(`![[${IMAGE}]]`);
    expect(client.uploads).toEqual([]);
    expect(client.updates).toEqual([]);
  });

  it('stops the push when the file is resolvable but unreadable', async () => {
    // Planned, then gone before the bytes were wanted.
    vault.embedTargets.set(IMAGE, IMAGE);
    await seed(`An edited body.\n\n![[${IMAGE}]]\n`);

    const outcome = await push();

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.blocked.error.code).toBe('NOT_FOUND');
    expect(client.updates).toEqual([]);
  });
});
