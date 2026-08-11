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
 * The push gates (spec §3.5, US-4).
 *
 * Every test here asserts on what left the machine as much as on what came back:
 * `client.updates` is empty for every refusal, because a gate that reports a
 * problem *after* writing to a corporate wiki is not a gate.
 */

const NOW = '2026-08-11T09:00:00Z';
const BODY = '<p>The original body.</p>';

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
    localPath: 'ENG/Architecture.md',
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

/**
 * Seeds the vault and the fragment cache the way a completed pull would leave
 * them, so a test only has to say how the *user* then changed the note.
 */
async function seed(storage = BODY, markdownOverride?: string): Promise<void> {
  const converted = storageToMarkdown(storage, { baseUrl: 'https://wiki.corp', spaceKey: 'ENG' });
  if (!converted.ok) throw new Error('fixture does not convert');

  const markdown = markdownOverride ?? converted.value.markdown;
  vault.files.set('ENG/Architecture.md', `---\nconfluence:\n  id: 1\n---\n${markdown}`);
  await fragments.save('1', await sha256(storage), converted.value.fragments);
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
    now: () => NOW,
  };
});

function push(state = pageState(), options = {}): Promise<PushOutcome> {
  return pushPage(deps, { state, spaceKey: 'ENG' }, options);
}

describe('a successful push (FR-5.4, US-4)', () => {
  beforeEach(async () => {
    await seed();
    vault.files.set('ENG/Architecture.md', '---\nconfluence:\n  id: 1\n---\nAn edited body.\n');
  });

  it('sends the converted body at one past the stored version', async () => {
    const outcome = await push();

    expect(outcome.kind).toBe('pushed');
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]?.version).toBe(5);
    expect(client.updates[0]?.storage).toContain('An edited body.');
  });

  it('keeps the page where it is in the tree', async () => {
    // A PUT that omits `ancestors` reparents the page to the top of the space on
    // some Data Center versions.
    await push();

    expect(client.updates[0]?.parentId).toBe('900');
    expect(client.updates[0]?.spaceKey).toBe('ENG');
  });

  it('records the new remote version and rehashes the file as written', async () => {
    const outcome = await push();
    if (outcome.kind !== 'pushed') throw new Error('expected a push');

    expect(outcome.state.remoteVersion).toBe(5);
    // The next sync compares this hash against the file on disk. If it were the
    // hash of the body *before* the frontmatter was rewritten, the note would look
    // modified again the moment it was pushed.
    expect(outcome.state.localHash).toBe(
      await sha256(vault.files.get('ENG/Architecture.md') ?? ''),
    );
    expect(outcome.state.lastSyncedAt).toBe(NOW);
  });

  it('leaves the body the user wrote untouched', async () => {
    await push();

    expect(vault.files.get('ENG/Architecture.md')).toContain('An edited body.');
  });

  it('reassociates the cached fragments with the body that was sent', async () => {
    await push();

    const stored = await fragments.load('1');
    if (!stored.ok || stored.value === null) throw new Error('fragments went missing');
    expect(stored.value.storageHash).toBe(await sha256(client.updates[0]?.storage ?? ''));
  });
});

describe('the gates that stop a push', () => {
  it('refuses a degraded page and offers Confluence instead (FR-5.3)', async () => {
    await seed();

    const outcome = await push(pageState({ fidelity: 'degraded' }));

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('FIDELITY_DEGRADED');
    expect(outcome.blocked.error.action).toBe('open-in-confluence');
    expect(client.updates).toHaveLength(0);
  });

  it('refuses a page whose preserved fragments are gone (§6.4.3 rule 4)', async () => {
    // The note is there; the sidecar is not. This is the copy-pasted-placeholder
    // defence, and it must not be possible to push past it.
    vault.files.set('ENG/Architecture.md', '---\nconfluence:\n  id: 1\n---\nA body.\n');

    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('FRAGMENT_MISSING');
    expect(outcome.blocked.error.action).toBe('repull-page');
    expect(client.updates).toHaveLength(0);
  });

  it('refuses an edit that cannot round-trip, and says exactly where (FR-5.2)', async () => {
    // A placeholder sentinel the user has broken by hand: the reverse pass cannot
    // find the fragment behind `cfb-9999`.
    await seed('<p>Text <ac:link><ri:user ri:username="jo"/></ac:link> more.</p>');
    vault.files.set(
      'ENG/Architecture.md',
      '---\nconfluence:\n  id: 1\n---\nText `{cf:cfb-9999}` more.\n',
    );

    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('FRAGMENT_MISSING');
    expect(client.updates).toHaveLength(0);
  });

  it('blocks a construct storage format has no form for at all', async () => {
    await seed();
    // A footnote is Markdown the converter cannot turn into storage *at all*, as
    // opposed to one it turns into something slightly different. There is no body
    // to send, so not even force push can help — and the message names the reason.
    vault.files.set(
      'ENG/Architecture.md',
      '---\nconfluence:\n  id: 1\n---\nA claim[^1]\n\n[^1]: the source\n',
    );

    const outcome = await push(pageState(), { force: true });

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('VERIFICATION_FAILED');
    expect(outcome.blocked.error.userMessage).toContain('footnote');
    expect(client.updates).toHaveLength(0);
  });

  it('reports a vault read failure rather than pushing an empty body', async () => {
    const outcome = await push(pageState({ localPath: 'ENG/Missing.md' }));

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('NOT_FOUND');
    expect(client.updates).toHaveLength(0);
  });
});

describe('force push (FR-5.7)', () => {
  beforeEach(async () => {
    await seed();
    // `_x_` and `*x*` are the same `<em>`, but the reverse pass writes the second
    // form — so this converts perfectly and still fails the comparison. That is
    // exactly the case force push exists for: a rewrite the user can see and
    // accept, rather than content that cannot be represented at all.
    vault.files.set('ENG/Architecture.md', '---\nconfluence:\n  id: 1\n---\nA _stressed_ word.\n');
  });

  it('is refused without the flag', async () => {
    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('VERIFICATION_FAILED');
    expect(client.updates).toHaveLength(0);
  });

  it('hands back both versions so the user can see what would change (FR-5.2)', async () => {
    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.local).toContain('_stressed_');
    expect(outcome.blocked.roundTripped).toContain('*stressed*');
  });

  it('goes through with it, carrying only what could be represented', async () => {
    const outcome = await push(pageState(), { force: true });

    expect(outcome.kind).toBe('pushed');
    expect(client.updates).toHaveLength(1);
    expect(client.updates[0]?.storage).toContain('<em>stressed</em>');
  });

  it('still refuses to overwrite a remote edit', async () => {
    // Forcing is the user authorising the loss of their *own* unrepresentable
    // markup. It is never authority over somebody else's version.
    client.pages = [{ id: '1', title: 'Architecture', version: 9, storage: BODY }];

    const outcome = await push(pageState(), { force: true });

    expect(outcome.kind).toBe('conflict');
    expect(client.updates).toHaveLength(0);
  });
});

describe('conflict detection before any write (FR-6.1, FR-6.2)', () => {
  beforeEach(async () => {
    await seed();
    vault.files.set('ENG/Architecture.md', '---\nconfluence:\n  id: 1\n---\nMy local edit.\n');
    client.pages = [
      { id: '1', title: 'Architecture', version: 7, storage: '<p>A colleague wrote this.</p>' },
    ];
  });

  it('detects the divergence and sends nothing', async () => {
    const outcome = await push();

    expect(outcome.kind).toBe('conflict');
    expect(client.updates).toHaveLength(0);
  });

  it('carries what the modal needs: author, timestamp and both bodies (FR-6.3)', async () => {
    const outcome = await push();
    if (outcome.kind !== 'conflict') throw new Error('expected a conflict');

    expect(outcome.conflict.remoteVersion).toBe(7);
    expect(outcome.conflict.remoteUpdatedBy).toBe('j.smith');
    expect(outcome.conflict.remoteUpdatedAt).toBe('2026-08-09T14:03:11Z');
    expect(outcome.conflict.localBody).toContain('My local edit.');
    expect(outcome.conflict.remoteBody).toContain('A colleague wrote this.');
  });

  it('treats a 409 as a conflict, never as a retryable error (FR-5.5)', async () => {
    // The version check passed and Confluence still refused: somebody wrote
    // between the read and the write.
    client.pages = [{ id: '1', title: 'Architecture', version: 4, storage: BODY }];
    client.conflictOnUpdate.add('1');

    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('CONFLICT');
    expect(client.updates).toHaveLength(1);
  });

  it('pushes onto the version the user was shown, when they chose Keep Local', async () => {
    const outcome = await push(pageState(), { ontoVersion: 7 });

    expect(outcome.kind).toBe('pushed');
    expect(client.updates[0]?.version).toBe(8);
  });
});

describe('failures after the body was accepted', () => {
  beforeEach(async () => {
    await seed();
    vault.files.set('ENG/Architecture.md', '---\nconfluence:\n  id: 1\n---\nAn edit.\n');
  });

  it('reports an update that Confluence rejected', async () => {
    client.updateError = new AppError('PERMISSION_DENIED', 'You cannot edit this page.');

    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('PERMISSION_DENIED');
  });

  it('reports a frontmatter write that failed after the page was updated', async () => {
    // The push landed but the local record could not be brought up to date. Said
    // out loud rather than swallowed: the next sync will see a version mismatch
    // and the user needs to know why.
    vault.failWrites.add('ENG/Architecture.md');

    const outcome = await push();

    if (outcome.kind !== 'blocked') throw new Error('expected a block');
    expect(outcome.blocked.error.code).toBe('VAULT_WRITE_FAILED');
    expect(client.updates).toHaveLength(1);
  });
});
