import type { ConfluenceGateway } from '../api/confluence-client';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import type { VaultGateway } from '../vault/vault-gateway';
import type { AttachmentState } from './sync-state';

/**
 * Uploading what a note embeds but the page does not have (spec FR-8.6).
 *
 * Two steps on purpose, and the order is the point:
 *
 *   1. `planUploads` resolves every unresolved embed to a vault file and returns a
 *      *provisional* attachment record. Conversion and verification run against
 *      that, so the embed becomes an `ac:image` and the round trip closes.
 *   2. `runUploads` actually sends the bytes, and only once every push gate has
 *      passed and the remote has been checked.
 *
 * Split that way because uploading first would leave a file attached to a page
 * whose body was then refused — and FR-8.7 means the plugin can never tidy it up.
 */

export interface UploadDeps {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly logger: Logger;
}

/** One file to send, resolved to somewhere real before anything is sent. */
export interface PlannedUpload {
  /** Vault path of the file, as Obsidian resolved the embed. */
  readonly localPath: string;
  /** Name it will carry in Confluence — its own file name. */
  readonly filename: string;
}

export interface UploadPlan {
  readonly uploads: readonly PlannedUpload[];
  /**
   * The attachment record conversion should use: what the page already has, plus
   * an entry for every planned upload.
   *
   * The provisional entries carry no id and version 0. Nothing in conversion reads
   * either — only the file name and the local path — and the real values replace
   * them once the upload has happened.
   */
  readonly attachments: Readonly<Record<string, AttachmentState>>;
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Plans the uploads for one note.
 *
 * Refuses, rather than guessing, in two cases:
 *
 *  - an embed that resolves to nothing. Obsidian shows the reader a broken embed
 *    already; uploading is impossible and inventing an attachment name would put a
 *    broken image into Confluence as well.
 *  - a file whose name collides with an attachment the page already has, pointing at
 *    a *different* local file. Confluence would file it as a new version of the
 *    existing attachment, so every other page embedding that name would silently
 *    change picture.
 *
 * A `![[note]]` transclusion is not an upload and is left alone: it is Obsidian
 * syntax for including a note, and the conversion leaves it as literal text.
 */
export function planUploads(
  deps: UploadDeps,
  notePath: string,
  embeds: ReadonlySet<string>,
  existing: Readonly<Record<string, AttachmentState>>,
): Result<UploadPlan, AppError> {
  const uploads: PlannedUpload[] = [];
  const attachments: Record<string, AttachmentState> = { ...existing };

  for (const embed of embeds) {
    const localPath = deps.vault.resolveEmbed(embed, notePath);
    if (localPath === null) {
      return err(
        new AppError(
          'NOT_FOUND',
          `"${notePath}" embeds "${embed}", which is not a file in this vault. ` +
            'Fix or remove the embed before pushing.',
        ),
      );
    }
    if (localPath.toLowerCase().endsWith('.md')) continue;

    // FR-8.2 makes the *full vault path* the form an attachment embed takes, chosen
    // to avoid name ambiguity — so it is also the only form that survives the round
    // trip: the reverse pass rebuilds the embed from the recorded path, and a bare
    // `![[diagram.png]]` would come back as `![[ENG/_attachments/1/diagram.png]]` and
    // fail verification. Refused here, where the message can say what to write,
    // rather than four steps later as a diff about square brackets.
    if (embed !== localPath) {
      return err(
        new AppError(
          'EMBED_UNSUPPORTED',
          `"${notePath}" embeds "${embed}". Write it as the full vault path — ` +
            `![[${localPath}]] — so Obsidian and Confluence cannot disagree about which ` +
            'file it means.',
        ),
      );
    }

    const filename = basename(localPath);
    const collision = attachments[filename];
    if (collision !== undefined && collision.localPath !== localPath) {
      return err(
        new AppError(
          'VAULT_WRITE_FAILED',
          `"${notePath}" embeds "${localPath}", but this page already has a different ` +
            `attachment called "${filename}". Rename the file before pushing.`,
        ),
      );
    }
    if (collision !== undefined) continue;

    uploads.push({ localPath, filename });
    attachments[filename] = { id: '', version: 0, localPath };
  }

  return ok({ uploads, attachments });
}

/**
 * Sends the planned files and returns the record with their real ids.
 *
 * An upload that fails stops the push. The alternative is publishing a page whose
 * embed points at an attachment that is not there, and a broken image in a
 * corporate wiki is exactly the silent damage §1.2 forbids.
 */
export async function runUploads(
  deps: UploadDeps,
  pageId: string,
  plan: UploadPlan,
): Promise<Result<Readonly<Record<string, AttachmentState>>, AppError>> {
  if (plan.uploads.length === 0) return ok(plan.attachments);

  const attachments: Record<string, AttachmentState> = { ...plan.attachments };

  for (const upload of plan.uploads) {
    const bytes = await deps.vault.readBinary(upload.localPath);
    if (!bytes.ok) return bytes;

    const uploaded = await deps.client.uploadAttachment(pageId, upload.filename, bytes.value);
    if (!uploaded.ok) return uploaded;

    attachments[upload.filename] = {
      id: uploaded.value.id,
      version: uploaded.value.version,
      localPath: upload.localPath,
    };
    deps.logger.debug(`Uploaded ${upload.filename} to page ${pageId}.`);
  }

  return ok(attachments);
}
