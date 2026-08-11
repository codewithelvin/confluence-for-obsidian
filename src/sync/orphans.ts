import { isInsideMount, type VaultGateway } from '../vault/vault-gateway';
import type { LocalPage } from './pull-planner';

/**
 * Telling a deleted note from a moved one (spec FR-7.4, FR-7.7).
 *
 * A sync scans the mount, so a note the user dragged *out* of the mount looks exactly
 * like a note they deleted: both are simply absent. The two need opposite answers.
 * A deleted note is an **orphan** — the page stays, and the panel offers to restore
 * the file or to delete the page explicitly (FR-7.4). A note that has merely left the
 * mount is an **error to report**, and the file must be left exactly where it is
 * (FR-7.7): moving it back would undo something the user plainly meant to do, and
 * treating it as an orphan would offer to delete a page that is still mirrored,
 * somewhere else.
 *
 * The vault-wide lookup runs only for pages already found missing, so a sync where
 * nothing went missing pays nothing for this.
 */

/** A tracked note that has left the mount (FR-7.7). */
export interface MisplacedNote extends LocalPage {
  /** Where it is now — outside every mount, or inside a different one. */
  readonly foundAt: string;
}

export interface OrphanSplit {
  /** Notes that are genuinely gone. The page is untouched (D6). */
  readonly orphans: readonly LocalPage[];
  readonly misplaced: readonly MisplacedNote[];
}

export function classifyOrphans(
  vault: Pick<VaultGateway, 'locateIdentity'>,
  candidates: readonly LocalPage[],
  mountPath: string,
): OrphanSplit {
  const orphans: LocalPage[] = [];
  const misplaced: MisplacedNote[] = [];

  for (const candidate of candidates) {
    const foundAt = vault.locateIdentity(candidate.pageId);

    // Found back inside this mount is neither: the scan would have seen it, so this
    // is a file the plugin is about to handle by identity in the ordinary way.
    if (foundAt === null || isInsideMount(foundAt, [mountPath])) {
      orphans.push(candidate);
      continue;
    }
    misplaced.push({ ...candidate, foundAt });
  }

  return { orphans, misplaced };
}
