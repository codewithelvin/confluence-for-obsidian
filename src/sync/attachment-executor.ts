import type { ConfluenceAttachment } from '../api/api-types';
import type { ConfluenceGateway } from '../api/confluence-client';
import { referencedAttachments } from '../convert/attachments';
import type { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { attachmentPath } from '../vault/path-mapper';
import type { VaultGateway } from '../vault/vault-gateway';
import type { AttachmentState } from './sync-state';
import type { SyncFailure } from './sync-types';

/**
 * Downloading a page's attachments (spec FR-8.1 to FR-8.5).
 *
 * Runs before the page's body is converted, because the converter can only write
 * an embed for a file that is already on disk (FR-8.2) — an embed pointing at
 * nothing is a broken image, which is worse than the placeholder it replaced.
 *
 * One attachment's failure never stops the others or the page (FR-3.9): a note
 * with one missing picture is far better than no note.
 */

export interface AttachmentDeps {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly logger: Logger;
  readonly mountPath: string;
  /** Skip anything larger (FR-8.4). */
  readonly sizeLimitBytes: number;
  /** Fetch only what the body refers to (FR-8.5). */
  readonly referencedOnly: boolean;
}

/** An attachment deliberately not downloaded, for the sync report. */
export interface SkippedAttachment {
  readonly pageId: string;
  readonly filename: string;
  readonly reason: string;
}

export interface AttachmentOutcome {
  /** What the page now has on disk, to record in the index. */
  readonly attachments: Readonly<Record<string, AttachmentState>>;
  readonly downloaded: number;
  readonly skipped: readonly SkippedAttachment[];
  readonly failures: readonly SyncFailure[];
}

export const EMPTY_ATTACHMENTS: AttachmentOutcome = {
  attachments: {},
  downloaded: 0,
  skipped: [],
  failures: [],
};

function tooLarge(attachment: ConfluenceAttachment, limitBytes: number): boolean {
  // A size the instance did not report cannot be judged, and refusing to
  // download on that basis would hide attachments for a whole instance.
  return attachment.size !== null && attachment.size > limitBytes;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Whether the copy on disk is already the copy Confluence has (FR-8.3).
 *
 * The file must still exist: an index entry whose file the user deleted has to
 * fetch again, or the note embeds nothing.
 */
function alreadyCurrent(
  deps: AttachmentDeps,
  previous: AttachmentState | undefined,
  attachment: ConfluenceAttachment,
): boolean {
  if (previous === undefined || previous.version !== attachment.version) return false;
  return deps.vault.exists(previous.localPath);
}

/**
 * The `attachments` hook `ExecutorDeps` asks for, bound to one subscription.
 *
 * Built here rather than at each call site so the sync path and the single-page
 * path cannot drift apart: both need the same reading of the same settings, and a
 * difference between them would show as an image that appears on a full sync and
 * vanishes on a re-pull.
 */
export function attachmentHook(
  deps: AttachmentDeps,
  recorded: (pageId: string) => Readonly<Record<string, AttachmentState>>,
): (
  item: { readonly page: { readonly id: string; readonly title: string } },
  storage: string,
) => Promise<AttachmentOutcome> {
  return (item, storage) =>
    syncAttachments(deps, item.page, referencedAttachments(storage), recorded(item.page.id));
}

export async function syncAttachments(
  deps: AttachmentDeps,
  page: { readonly id: string; readonly title: string },
  referenced: ReadonlySet<string>,
  previous: Readonly<Record<string, AttachmentState>>,
): Promise<AttachmentOutcome> {
  const listed = await deps.client.listAttachments(page.id);
  if (!listed.ok) {
    return { ...EMPTY_ATTACHMENTS, failures: [failure(page, listed.error)] };
  }

  const attachments: Record<string, AttachmentState> = {};
  const skipped: SkippedAttachment[] = [];
  const failures: SyncFailure[] = [];
  let downloaded = 0;

  for (const attachment of listed.value) {
    if (deps.referencedOnly && !referenced.has(attachment.filename)) continue;

    if (tooLarge(attachment, deps.sizeLimitBytes)) {
      skipped.push({
        pageId: page.id,
        filename: attachment.filename,
        reason: `${megabytes(attachment.size ?? 0)}, over the ${megabytes(deps.sizeLimitBytes)} limit`,
      });
      continue;
    }

    const existing = previous[attachment.filename];
    if (alreadyCurrent(deps, existing, attachment)) {
      attachments[attachment.filename] = existing as AttachmentState;
      continue;
    }

    const localPath = attachmentPath(deps.mountPath, page.id, attachment.filename);
    const bytes = await deps.client.downloadAttachment(attachment.downloadPath);
    if (!bytes.ok) {
      failures.push(failure(page, bytes.error));
      continue;
    }

    const written = await deps.vault.writeBinary(localPath, bytes.value);
    if (!written.ok) {
      failures.push(failure(page, written.error));
      continue;
    }

    attachments[attachment.filename] = {
      id: attachment.id,
      version: attachment.version,
      localPath,
    };
    downloaded += 1;
  }

  return { attachments, downloaded, skipped, failures };
}

function failure(
  page: { readonly id: string; readonly title: string },
  error: AppError,
): SyncFailure {
  return { pageId: page.id, title: page.title, error };
}
