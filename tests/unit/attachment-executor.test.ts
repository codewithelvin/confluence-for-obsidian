import { beforeEach, describe, expect, it } from 'vitest';
import { syncAttachments, type AttachmentDeps } from '../../src/sync/attachment-executor';
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

const REFERENCED = new Set(['a.png']);

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

    const outcome = await syncAttachments(deps({ referencedOnly: false }), PAGE, new Set(), {});

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

    const outcome = await syncAttachments(deps(), PAGE, new Set(), {});

    expect(outcome).toEqual({ attachments: {}, downloaded: 0, skipped: [], failures: [] });
    expect(client.downloaded).toEqual([]);
  });

  it('still asks when the setting wants everything, referenced or not', async () => {
    listed();

    await syncAttachments(deps({ referencedOnly: false }), PAGE, new Set(), {});

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

    const outcome = await syncAttachments(deps(), PAGE, new Set(['bad.png', 'good.png']), {});

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
