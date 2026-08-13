import type { ConfluenceAttachment } from '../api/api-types';
import type { ConfluenceGateway } from '../api/confluence-client';
import {
  normaliseFilename,
  referencedAttachments,
  type ReferencedAttachments,
} from '../convert/attachments';
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

/** How many of the page's own file names to quote when a reference misses. */
const NAMES_SHOWN = 6;

/**
 * Names the body asks for that no attachment on the page matches (spec FR-8.9).
 *
 * An `ri:attachment` reference outlives the attachment it names: someone deletes or
 * renames the file and the body keeps pointing at the old name, in Confluence as much
 * as here. FR-4.17 then leaves a widget rather than a broken picture, which is right —
 * but it used to happen in silence, so a page showing five of its seventeen screenshots
 * looked exactly like a page whose download had not finished.
 *
 * **The reason says what this actually knows, which is less than it first said.** The
 * comparison is a name match, so a miss means *no attachment of that name*, not
 * necessarily a file Confluence does not have: a renamed file, a stray space, or a
 * second Unicode spelling all miss too, and reporting them as "Confluence does not have
 * it" is a claim about the instance this code cannot support — and one that sends the
 * user to re-upload a file that is already there.
 *
 * So the page's own names are quoted alongside. That is what makes the difference
 * visible: a reference to `Surəti Düzəliş.xlsx` beside a listing holding `Sürəti
 * Düzəliş.xlsx` diagnoses itself, where a bare verdict could not.
 */
function unmatched(
  page: { readonly id: string },
  named: ReadonlySet<string>,
  listed: readonly ConfluenceAttachment[],
): readonly SkippedAttachment[] {
  const held = new Set(listed.map((attachment) => normaliseFilename(attachment.filename)));

  const names = listed.map((attachment) => attachment.filename);
  const quoted =
    names.length === 0
      ? 'the page has no attachments at all'
      : `the page has ${String(names.length)}: ${names.slice(0, NAMES_SHOWN).join(', ')}${
          names.length > NAMES_SHOWN ? ', …' : ''
        }`;

  return [...named]
    .filter((filename) => !held.has(normaliseFilename(filename)))
    .map((filename) => ({
      pageId: page.id,
      filename,
      reason: `no attachment of this name is on the page — ${quoted}`,
    }));
}

/** An attachment refused for its size, as the report words it (FR-8.4). */
function overLimit(
  deps: AttachmentDeps,
  page: { readonly id: string },
  attachment: ConfluenceAttachment,
): SkippedAttachment {
  return {
    pageId: page.id,
    filename: attachment.filename,
    reason: `${megabytes(attachment.size ?? 0)}, over the ${megabytes(deps.sizeLimitBytes)} limit`,
  };
}

/**
 * Downloads one attachment onto disk, or reports why not.
 *
 * The two steps are one operation from the caller's point of view — a fetch that did
 * not land is a fetch that did not happen — and neither may record the attachment,
 * because an index entry for a file that is not there leaves the note embedding nothing.
 */
async function fetchInto(
  deps: AttachmentDeps,
  localPath: string,
  attachment: ConfluenceAttachment,
): Promise<AppError | null> {
  const bytes = await deps.client.downloadAttachment(attachment.downloadPath);
  if (!bytes.ok) return bytes.error;

  const written = await deps.vault.writeBinary(localPath, bytes.value);
  return written.ok ? null : written.error;
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
  const skipped: SkippedAttachment[] = [...unmatched(page, referenced.named, listed.value)];
  const failures: SyncFailure[] = [];
  let downloaded = 0;

  for (const attachment of listed.value) {
    // Compared in one Unicode form (FR-8.10): the body and the listing need not agree
    // byte for byte, and a file uploaded from a Mac is listed decomposed while the body
    // references it composed. Matched raw, that file is silently never downloaded.
    if (deps.referencedOnly && !referenced.all.has(normaliseFilename(attachment.filename))) {
      continue;
    }

    if (tooLarge(attachment, deps.sizeLimitBytes)) {
      skipped.push(overLimit(deps, page, attachment));
      continue;
    }

    // Keyed in the same one form the converter will look it up by (FR-8.10), or a
    // downloaded file would still resolve to nothing and still leave a widget.
    const key = normaliseFilename(attachment.filename);

    const existing = previous[key];
    if (alreadyCurrent(deps, existing, attachment)) {
      attachments[key] = existing as AttachmentState;
      continue;
    }

    const localPath = attachmentPath(deps.mountPath, page.id, attachment.filename);
    const fetched = await fetchInto(deps, localPath, attachment);
    if (fetched !== null) {
      failures.push(failure(page, fetched));
      continue;
    }

    attachments[key] = {
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
