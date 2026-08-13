import { beforeEach, describe, expect, it } from 'vitest';
import { syncAttachments, type AttachmentDeps } from '../../src/sync/attachment-executor';
import type { ReferencedAttachments } from '../../src/convert/attachments';
import type { AttachmentState } from '../../src/sync/sync-state';
import { AppError } from '../../src/util/errors';
import { Logger } from '../../src/util/logger';
import { FakeConfluence, FakeVaultGateway } from '../fakes/sync';

/**
 * The attachment downloader in isolation (spec FR-8.1 to FR-8.5).
 *
 * The engine tests prove an image ends up embedded; these prove the decisions
 * *around* the download — what is skipped, what is reused, what a failure costs —
 * which are the paths a full sync only reaches by accident.
 */

const PAGE = { id: '1', title: 'A' };
const LIMIT = 25 * 1_048_576;

let client: FakeConfluence;
let vault: FakeVaultGateway;

beforeEach(() => {
  client = new FakeConfluence();
  vault = new FakeVaultGateway();
});

function deps(overrides: Partial<AttachmentDeps> = {}): AttachmentDeps {
  return {
    client,
    vault,
    logger: new Logger('test', () => false),
    mountPath: 'EP',
    sizeLimitBytes: LIMIT,
    referencedOnly: true,
    ...overrides,
  };
}

function listed(size: number | null = 512, version = 1): void {
  client.attachments.set('1', [
    { id: 'att1', filename: 'a.png', version, size, downloadPath: '/download/a.png' },
  ]);
}

/**
 * What a body referred to, as the downloader is given it.
 *
 * `named` defaults to the same names, which is what an `ri:filename` reference
 * produces. A diagram candidate is the only kind that appears in `all` alone, and its
 * absence from the page is expected rather than worth reporting.
 */
function refs(all: readonly string[], named: readonly string[] = all): ReferencedAttachments {
  return { all: new Set(all), named: new Set(named) };
}

const NOTHING = refs([]);
const REFERENCED = refs(['a.png']);

describe('what gets downloaded', () => {
  it('writes the bytes and reports the path for the converter', async () => {
    listed();

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, {});

    expect(outcome.downloaded).toBe(1);
    expect(outcome.attachments['a.png']?.localPath).toBe('EP/_attachments/1/a.png');
    expect(vault.binaries.has('EP/_attachments/1/a.png')).toBe(true);
  });

  it('downloads an unreferenced attachment when the setting says so (FR-8.5)', async () => {
    listed();

    const outcome = await syncAttachments(deps({ referencedOnly: false }), PAGE, NOTHING, {});

    expect(outcome.downloaded).toBe(1);
  });

  it('reuses the copy on disk when the version has not moved (FR-8.3)', async () => {
    listed(512, 4);
    const previous: Record<string, AttachmentState> = {
      'a.png': { id: 'att1', version: 4, localPath: 'EP/_attachments/1/a.png' },
    };
    vault.binaries.set('EP/_attachments/1/a.png', new Uint8Array([1]));

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, previous);

    expect(client.downloaded).toEqual([]);
    expect(outcome.downloaded).toBe(0);
    // Still reported, or the converter would treat it as absent and write a
    // placeholder over a picture that is right there on disk.
    expect(outcome.attachments['a.png']?.localPath).toBe('EP/_attachments/1/a.png');
  });
});

describe('requests it does not make', () => {
  it('does not ask for a listing when the body names no attachment', async () => {
    // One wasted round trip per page, serialised through the four-request cap, is
    // the difference between a large space syncing in minutes and in tens of them.
    listed();

    const outcome = await syncAttachments(deps(), PAGE, NOTHING, {});

    expect(outcome).toEqual({ attachments: {}, downloaded: 0, skipped: [], failures: [] });
    expect(client.downloaded).toEqual([]);
  });

  it('still asks when the setting wants everything, referenced or not', async () => {
    listed();

    await syncAttachments(deps({ referencedOnly: false }), PAGE, NOTHING, {});

    expect(client.downloaded).toEqual(['/download/a.png']);
  });
});

describe('what is refused, and why', () => {
  it('skips an oversized attachment with a readable reason (FR-8.4)', async () => {
    listed(30 * 1_048_576);

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, {});

    expect(outcome.downloaded).toBe(0);
    expect(outcome.skipped).toEqual([
      { pageId: '1', filename: 'a.png', reason: '30.0 MB, over the 25.0 MB limit' },
    ]);
  });

  it('downloads an attachment whose size the instance did not report', async () => {
    listed(null);

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, {});

    expect(outcome.downloaded).toBe(1);
    expect(outcome.skipped).toEqual([]);
  });

  it('downloads one exactly at the limit, since the limit is a maximum', async () => {
    listed(LIMIT);

    expect((await syncAttachments(deps(), PAGE, REFERENCED, {})).downloaded).toBe(1);
  });
});

describe('a name the page refers to but does not have (FR-8.9)', () => {
  it('is reported, so a missing picture is not silence', async () => {
    // An `ri:attachment` reference outlives the attachment it names. Page 28603486 of
    // space EP names seventeen images and Confluence lists five, which is why twelve
    // of them show a widget — and until this, why that looked identical to a download
    // that had not finished.
    listed();

    const outcome = await syncAttachments(deps(), PAGE, refs(['a.png', 'gone.png']), {});

    expect(outcome.downloaded).toBe(1);
    expect(outcome.skipped).toEqual([
      {
        pageId: '1',
        filename: 'gone.png',
        reason: 'referenced by the page, but Confluence does not have it',
      },
    ]);
  });

  it('says nothing about a diagram candidate that missed', async () => {
    // Two of `diagramCandidates`' three rungs always miss — they are guesses, and the
    // real listing is what decides. Reporting them would bury the real news.
    listed();

    const outcome = await syncAttachments(
      deps(),
      PAGE,
      refs(['a.png', 'D.png', 'D.drawio.png', 'D'], ['a.png']),
      {},
    );

    expect(outcome.skipped).toEqual([]);
  });

  it('reports it alongside an attachment refused for its size', async () => {
    listed(30 * 1_048_576);

    const outcome = await syncAttachments(deps(), PAGE, refs(['a.png', 'gone.png']), {});

    expect(outcome.skipped.map((item) => item.filename).sort()).toEqual(['a.png', 'gone.png']);
  });

  it('says nothing when the listing could not be read at all', async () => {
    // The page's attachments are unknown, not absent, and naming every reference as
    // missing would be a lie the user would act on.
    client.listError = new AppError('NETWORK_UNREACHABLE', 'The listing could not be read.');

    const outcome = await syncAttachments(deps(), PAGE, refs(['a.png', 'gone.png']), {});

    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
  });
});

describe('failures never stop the page (FR-3.9)', () => {
  it('reports a listing failure and downloads nothing', async () => {
    client.listError = new AppError('NETWORK_UNREACHABLE', 'The listing could not be read.');

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, {});

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.attachments).toEqual({});
    expect(client.downloaded).toEqual([]);
  });

  it('reports a download failure and keeps going', async () => {
    client.attachments.set('1', [
      { id: 'a', filename: 'bad.png', version: 1, size: 10, downloadPath: '/download/bad.png' },
      { id: 'b', filename: 'good.png', version: 1, size: 10, downloadPath: '/download/good.png' },
    ]);
    client.failDownload.add('/download/bad.png');

    const outcome = await syncAttachments(deps(), PAGE, refs(['bad.png', 'good.png']), {});

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.downloaded).toBe(1);
    expect(outcome.attachments['good.png']).toBeDefined();
    expect(outcome.attachments['bad.png']).toBeUndefined();
  });

  it('reports a write failure without recording the attachment', async () => {
    // Recording it would leave the note embedding a file that is not there.
    listed();
    vault.failWrites.add('EP/_attachments/1/a.png');

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, {});

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.attachments).toEqual({});
  });

  it('re-downloads when the index remembers a file the user deleted', async () => {
    listed(512, 4);
    const previous: Record<string, AttachmentState> = {
      'a.png': { id: 'att1', version: 4, localPath: 'EP/_attachments/1/a.png' },
    };

    const outcome = await syncAttachments(deps(), PAGE, REFERENCED, previous);

    expect(outcome.downloaded).toBe(1);
  });
});
