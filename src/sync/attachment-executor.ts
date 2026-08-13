import type { ConfluenceAttachment } from '../api/api-types';
import type { ConfluenceGateway } from '../api/confluence-client';
import { referencedAttachments, type ReferencedAttachments } from '../convert/attachments';
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
 * Names the body asks for that the page does not have (spec FR-8.9).
 *
 * An `ri:attachment` reference outlives the attachment it names: someone deletes or
 * renames the file and the body keeps pointing at the old name, in Confluence as much
 * as here. FR-4.17 then leaves a widget rather than a broken picture, which is right —
 * but until now it happened in silence, so a page showing five of its seventeen
 * screenshots looked exactly like a page whose download had not finished. Page
 * 28603486 of space EP is the case: twelve of its seventeen image references name a
 * file Confluence no longer lists.
 *
 * Reported per name, not per page, because the fix is per name — re-attach the file in
 * Confluence and the picture appears on the next pull, with no change here.
 */
function unlisted(
  page: { readonly id: string },
  named: ReadonlySet<string>,
  listed: readonly ConfluenceAttachment[],
): readonly SkippedAttachment[] {
  const held = new Set(listed.map((attachment) => attachment.filename));

  return [...named]
    .filter((filename) => !held.has(filename))
    .map((filename) => ({
      pageId: page.id,
      filename,
      reason: 'referenced by the page, but Confluence does not have it',
    }));
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
  referenced: ReferencedAttachments,
  previous: Readonly<Record<string, AttachmentState>>,
): Promise<AttachmentOutcome> {
  // A page whose body names no attachment has nothing to fetch, and asking
  // Confluence for its listing only to discard every entry costs one round trip
  // per page — serialised through the four-request cap, that is the difference
  // between a large space syncing in minutes and in tens of minutes.
  if (deps.referencedOnly && referenced.all.size === 0) return EMPTY_ATTACHMENTS;

  const listed = await deps.client.listAttachments(page.id);
  if (!listed.ok) {
    return { ...EMPTY_ATTACHMENTS, failures: [failure(page, listed.error)] };
  }

  const attachments: Record<string, AttachmentState> = {};
  const skipped: SkippedAttachment[] = [...unlisted(page, referenced.named, listed.value)];
  const failures: SyncFailure[] = [];
  let downloaded = 0;

  for (const attachment of listed.value) {
    if (deps.referencedOnly && !referenced.all.has(attachment.filename)) continue;

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
