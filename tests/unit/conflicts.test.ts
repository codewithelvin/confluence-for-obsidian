import { beforeEach, describe, expect, it } from 'vitest';
import { attachmentHook } from '../../src/sync/attachment-executor';
import { BackupStore, backupName, backupTakenAt } from '../../src/sync/backup-store';
import { commentHook } from '../../src/sync/comments-executor';
import {
  resolveConflict,
  type ConflictChoice,
  type ConflictDeps,
  type ConflictOutcome,
} from '../../src/sync/conflict-executor';
import { FragmentStore } from '../../src/sync/fragment-store';
import { stripManagedRegions } from '../../src/sync/managed-regions';
import { describeConflict, type PushDeps } from '../../src/sync/push-executor';
import type { PageState } from '../../src/sync/sync-state';
import { Logger } from '../../src/util/logger';
import { sha256 } from '../../src/util/hash';
import { FakeConfluence, FakeStateGateway, FakeVaultGateway } from '../fakes/sync';

/**
 * Conflict resolution and backups (spec §3.6, FR-6.1 to FR-6.6, US-5).
 *
 * The invariant every test here is really about: **no local file is overwritten
 * before its backup is on disk**, and no resolution silently loses either side's
 * work. Decision D4 rules out merging, so these three choices are the whole
 * behaviour and each has to be exactly right.
 */

const NOW = '2026-08-11T09:00:00Z';
const LOCAL = '---\nconfluence:\n  id: 1\n---\nWhat I wrote locally.\n';
const REMOTE_STORAGE = '<p>What a colleague wrote.</p>';

let vault: FakeVaultGateway;
let stateGateway: FakeStateGateway;
let client: FakeConfluence;
let deps: ConflictDeps;
let push: PushDeps;

function pageState(extra: Partial<PageState> = {}): PageState {
  return {
    pageId: '1',
    title: 'Architecture',
    parentId: null,
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

beforeEach(async () => {
  vault = new FakeVaultGateway();
  stateGateway = new FakeStateGateway();
  client = new FakeConfluence();
  client.pages = [{ id: '1', title: 'Architecture', version: 7, storage: REMOTE_STORAGE }];
  vault.files.set('ENG/Architecture.md', LOCAL);

  const fragments = new FragmentStore(stateGateway);
  // A completed pull always leaves a sidecar, even for a page with no preserved
  // content. Without one, every push here would stop at the FRAGMENT_MISSING gate
  // before reaching the behaviour under test.
  await fragments.save('1', await sha256(REMOTE_STORAGE), new Map());

  const logger = new Logger('test', () => false);

  push = {
    client,
    vault,
    fragments,
    logger,
    baseUrl: 'https://wiki.corp',
    spaceKey: 'ENG',
    strictMarkup: false,
    resolveTarget: () => null,
    resolveVaultPath: () => null,
    resolvePageId: () => null,
    now: () => NOW,
  };

  deps = {
    push,
    pull: {
      ...push,
      attachments: attachmentHook(
        { client, vault, logger, mountPath: 'ENG', sizeLimitBytes: 1e9, referencedOnly: true },
        () => ({}),
      ),
      comments: commentHook({ client, vault, logger, enabled: true }),
    },
    backups: new BackupStore({
      state: stateGateway,
      logger,
      retentionDays: () => 14,
      now: () => NOW,
    }),
  };
});

async function resolve(choice: ConflictChoice, state = pageState()): Promise<ConflictOutcome> {
  const conflict = await describeConflict(push, { state, spaceKey: 'ENG' });
  if (!conflict.ok) throw new Error(`could not describe: ${conflict.error.userMessage}`);

  return resolveConflict(deps, { conflict: conflict.value, choice }, state, 'ENG');
}

function backups(): string[] {
  return [...stateGateway.files.keys()].filter((name) => name.startsWith('backups/'));
}

describe('describing a conflict for the modal (FR-6.3)', () => {
  it('reports both bodies, the remote author and the remote timestamp', async () => {
    const described = await describeConflict(push, { state: pageState(), spaceKey: 'ENG' });
    if (!described.ok) throw new Error('expected a description');

    expect(described.value.localBody).toBe('What I wrote locally.');
    expect(described.value.remoteBody).toContain('What a colleague wrote.');
    expect(described.value.remoteVersion).toBe(7);
    expect(described.value.remoteUpdatedBy).toBe('j.smith');
  });

  it('does not run the verification gate first', async () => {
    // A note that cannot be pushed still has a conflict worth showing: answering
    // "your markup is unrepresentable" to "what did my colleague change?" would
    // hide their edit entirely.
    vault.files.set(
      'ENG/Architecture.md',
      '---\nconfluence:\n  id: 1\n---\nA claim[^1]\n\n[^1]: x\n',
    );

    const described = await describeConflict(push, { state: pageState(), spaceKey: 'ENG' });

    expect(described.ok).toBe(true);
  });
});

describe('Keep Local (FR-6.4)', () => {
  it('pushes onto the version the user was shown, not the stored one', async () => {
    const outcome = await resolve('keep-local');

    expect(outcome.error).toBeNull();
    expect(client.updates[0]?.version).toBe(8);
    expect(outcome.state?.remoteVersion).toBe(8);
  });

  it('leaves the local note as the user wrote it', async () => {
    await resolve('keep-local');

    expect(vault.files.get('ENG/Architecture.md')).toContain('What I wrote locally.');
    expect(backups()).toHaveLength(0);
  });

  it('is still subject to verification', async () => {
    // Choosing to supersede a colleague is one decision; writing a body the plugin
    // cannot reproduce is a different one, and this choice does not grant it.
    vault.files.set(
      'ENG/Architecture.md',
      '---\nconfluence:\n  id: 1\n---\nA claim[^1]\n\n[^1]: x\n',
    );

    const outcome = await resolve('keep-local');

    expect(outcome.error?.code).toBe('VERIFICATION_FAILED');
    expect(outcome.blocked).not.toBeNull();
    expect(client.updates).toHaveLength(0);
  });

  it('refuses when the page changed again while the modal was open', async () => {
    const described = await describeConflict(push, { state: pageState(), spaceKey: 'ENG' });
    if (!described.ok) throw new Error('expected a description');

    // Somebody edits it a third time between the modal opening and the answer
    // arriving. The user authorised superseding v7 — not v11, whose diff they have
    // never seen.
    client.pages = [
      { id: '1', title: 'Architecture', version: 11, storage: '<p>A third edit.</p>' },
    ];

    const outcome = await resolveConflict(
      deps,
      { conflict: described.value, choice: 'keep-local' },
      pageState(),
      'ENG',
    );

    expect(outcome.error?.code).toBe('CONFLICT');
    expect(outcome.error?.userMessage).toContain('again');
    expect(client.updates).toHaveLength(0);
  });
});

describe('Keep Remote (FR-6.4, FR-6.6, US-5)', () => {
  it('backs the local file up before replacing it', async () => {
    const outcome = await resolve('keep-remote');

    expect(outcome.error).toBeNull();
    expect(backups()).toHaveLength(1);
    expect(stateGateway.files.get(backups()[0] ?? '')).toContain('What I wrote locally.');
  });

  it('replaces the note with the remote version', async () => {
    await resolve('keep-remote');

    const written = vault.files.get('ENG/Architecture.md') ?? '';
    expect(written).toContain('What a colleague wrote.');
    expect(written).not.toContain('What I wrote locally.');
  });

  it('records the remote version so the conflict does not recur', async () => {
    const outcome = await resolve('keep-remote');

    expect(outcome.state?.remoteVersion).toBe(7);
  });

  it('refuses to overwrite anything when the backup could not be written', async () => {
    // The whole promise of FR-6.6. A backup that failed must cancel the write, not
    // be noted and skipped.
    stateGateway.failWrites = true;

    const outcome = await resolve('keep-remote');

    expect(outcome.error?.code).toBe('VAULT_WRITE_FAILED');
    expect(vault.files.get('ENG/Architecture.md')).toContain('What I wrote locally.');
  });

  it('sends nothing to Confluence', async () => {
    await resolve('keep-remote');

    expect(client.updates).toHaveLength(0);
  });
});

describe('Save Both (FR-6.4, §16 O6)', () => {
  it('writes the remote copy beside the note, named by its version', async () => {
    const outcome = await resolve('save-both');

    expect(outcome.copyPath).toBe('ENG/Architecture (remote v7).md');
    expect(vault.files.get('ENG/Architecture (remote v7).md')).toContain('What a colleague wrote.');
  });

  it('leaves the local note completely alone', async () => {
    await resolve('save-both');

    expect(vault.files.get('ENG/Architecture.md')).toBe(LOCAL);
    expect(client.updates).toHaveLength(0);
  });

  it('marks the copy so sync ignores it rather than offering to promote it', async () => {
    await resolve('save-both');

    const scanned = await vault.scan('ENG');
    if (!scanned.ok) throw new Error('scan failed');
    const copy = scanned.value.find((note) => note.path.includes('(remote v7)'));
    expect(copy?.isConflictCopy).toBe(true);
  });

  it('advances the recorded remote version but not the local hash', async () => {
    // The user has now *seen* v7, so the conflict is settled and must not fire on
    // every future sync. The note is still theirs and still modified, so it stays
    // in "edited locally" until they merge and push.
    const outcome = await resolve('save-both');

    expect(outcome.state?.remoteVersion).toBe(7);
    expect(outcome.state?.storageHash).toBe(await sha256(REMOTE_STORAGE));
    expect(outcome.state?.localHash).toBe('stale');
  });

  it('reports a copy that could not be written', async () => {
    vault.failWrites.add('ENG/Architecture (remote v7).md');

    const outcome = await resolve('save-both');

    expect(outcome.error?.code).toBe('VAULT_WRITE_FAILED');
    expect(outcome.copyPath).toBeNull();
  });
});

describe('Skip', () => {
  it('touches nothing at all, on either side', async () => {
    const outcome = await resolve('skip');

    expect(outcome.state).toBeNull();
    expect(outcome.error).toBeNull();
    expect(vault.files.get('ENG/Architecture.md')).toBe(LOCAL);
    expect(client.updates).toHaveLength(0);
    expect(backups()).toHaveLength(0);
  });
});

describe('the backup store (FR-6.6, §16 O7)', () => {
  it('keeps backups out of the vault entirely', async () => {
    await resolve('keep-remote');

    // Answering O7: a `.md` file inside the mount would be reported as an
    // untracked candidate (FR-7.2), and D2 forbids writing anywhere else in the
    // vault. The plugin's own state directory is the only lawful home.
    expect([...vault.files.keys()]).toEqual(['ENG/Architecture.md']);
    expect(backups()[0]).toMatch(/^backups\//);
  });

  it('names a backup so the note it came from is recoverable', () => {
    const name = backupName('2026-08-11T09:30:12.345Z', 'ENG/Data Model/Schema v2.md');

    expect(name).toBe('backups/2026-08-11T09-30-12Z__ENG-Data-Model-Schema-v2.md');
    expect(backupTakenAt(name)).toBe(Date.parse('2026-08-11T09:30:12Z'));
  });

  it('does not collide two notes of the same name in different folders', () => {
    const one = backupName(NOW, 'ENG/Architecture/Overview.md');
    const two = backupName(NOW, 'ENG/Reporting/Overview.md');

    expect(one).not.toBe(two);
  });

  it('records which note a backup holds, in the file itself', async () => {
    await resolve('keep-remote');

    expect(stateGateway.files.get(backups()[0] ?? '')).toContain('Backup of ENG/Architecture.md');
  });

  it('prunes a backup past its retention and keeps one inside it', async () => {
    stateGateway.files.set(backupName('2026-07-01T09:00:00Z', 'ENG/Old.md'), 'old');
    stateGateway.files.set(backupName('2026-08-10T09:00:00Z', 'ENG/Recent.md'), 'recent');

    const pruned = await deps.backups.prune();

    expect(pruned.ok && pruned.value).toBe(1);
    expect(backups().some((name) => name.includes('Old'))).toBe(false);
    expect(backups().some((name) => name.includes('Recent'))).toBe(true);
  });

  it('keeps a file whose age it cannot establish', async () => {
    // Pruning something on a guess would be deleting a user's only copy.
    stateGateway.files.set('backups/hand-renamed.md', 'content');

    await deps.backups.prune();

    expect(backups()).toContain('backups/hand-renamed.md');
  });
});

describe('managed regions are never pushed (FR-5.8, §6.7)', () => {
  const REGION =
    '<!-- confluence:comments:begin -->\n> [!quote]- Comments (1)\n> **j.smith** — a remark\n' +
    '<!-- confluence:comments:end -->';

  it('strips the comments block and the blank line it sat behind', () => {
    expect(stripManagedRegions(`The body.\n\n${REGION}`)).toBe('The body.');
  });

  it('produces the same Markdown whether or not comments were pulled', () => {
    // Otherwise pulling comments changes the body hash and every page with a
    // comment looks permanently modified.
    expect(stripManagedRegions(`The body.\n\n${REGION}`)).toBe(stripManagedRegions('The body.\n'));
  });

  it('strips to the end of the file when the closing sentinel was deleted', () => {
    // §6.7 puts the region last, so there is nothing of the user's after it — and
    // leaving half a region in place would push a colleague's remark into the page.
    const damaged = 'The body.\n\n<!-- confluence:comments:begin -->\n> a remark\n';

    expect(stripManagedRegions(damaged)).toBe('The body.');
  });

  it('leaves a body with no region byte-identical', () => {
    expect(stripManagedRegions('A body\n\nwith paragraphs.')).toBe('A body\n\nwith paragraphs.');
  });

  it('keeps the conflict diff free of the comments block', async () => {
    vault.files.set('ENG/Architecture.md', `---\nconfluence:\n  id: 1\n---\nMine.\n\n${REGION}`);

    const described = await describeConflict(push, { state: pageState(), spaceKey: 'ENG' });
    if (!described.ok) throw new Error('expected a description');

    expect(described.value.localBody).toBe('Mine.');
  });
});
