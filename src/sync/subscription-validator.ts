import type { Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import { mountsOverlap } from '../vault/path-mapper';

/**
 * Subscription rules (spec FR-2.2, FR-2.5).
 *
 * Pure: no vault, no network. Creating a subscription is the one moment where
 * a bad value is cheap to reject and expensive to live with — an overlapping
 * mount is only discovered later, when two subscriptions start proposing to
 * delete each other's notes.
 */

export interface SubscriptionDraft {
  readonly connectionId: string;
  readonly spaceKey: string;
  readonly rootPageId: string | null;
  readonly mountPath: string;
}

/**
 * Normalises a user-entered mount path.
 *
 * Backslashes become forward slashes so a path pasted from Windows Explorer
 * works, and `.`/`..` segments are dropped: a mount is a vault-relative folder,
 * and one that climbs out of the vault would defeat the containment check that
 * the whole gateway rests on.
 */
export function normaliseMountPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
}

/** `null` when the draft may be saved, otherwise the reason it may not. */
export function validateSubscription(
  draft: SubscriptionDraft,
  existing: readonly Subscription[],
  editingId: string | null = null,
): AppError | null {
  if (draft.connectionId.length === 0) {
    return new AppError('INVALID_BASE_URL', 'Choose which Confluence connection to sync from.');
  }
  if (draft.spaceKey.trim().length === 0) {
    return new AppError('NOT_FOUND', 'Choose a Confluence space.');
  }

  const mountPath = normaliseMountPath(draft.mountPath);
  if (mountPath.length === 0) {
    return new AppError(
      'OUT_OF_MOUNT',
      'Enter a folder inside the vault to mirror this space into, for example "Confluence".',
    );
  }

  for (const other of existing) {
    if (other.id === editingId) continue;
    if (!mountsOverlap(mountPath, other.mountPath)) continue;

    return new AppError(
      'OUT_OF_MOUNT',
      `"${mountPath}" overlaps the folder already used by ${other.spaceKey} ` +
        `("${other.mountPath}"). Each subscription needs a folder of its own, and one cannot ` +
        'sit inside another.',
    );
  }

  return null;
}

export interface SizeWarning {
  readonly pageCount: number;
  readonly message: string;
}

/**
 * The warning shown before subscribing to a large subtree (spec FR-2.4).
 *
 * `null` page count means the server did not report a total. That is reported
 * as unknown rather than treated as zero — a silent endpoint must not read as
 * "this space is empty".
 */
export function sizeWarning(pageCount: number | null, threshold: number): SizeWarning | null {
  if (pageCount === null || pageCount <= threshold) return null;

  return {
    pageCount,
    message:
      `This subtree has ${String(pageCount)} pages. The first sync will download every one of ` +
      'them, which can take several minutes and will create that many notes in your vault. ' +
      'Subscribing to a page subtree instead of a whole space keeps it manageable.',
  };
}
