import type { PageTarget } from '../convert/types';
import type { Subscription } from '../settings/settings-types';
import type { SubscriptionState } from './sync-state';

/**
 * Which Confluence pages are mirrored where (spec FR-4.7).
 *
 * The converter is pure and cannot see the vault, so this is what it consults to
 * decide whether a page link can become a wikilink. Both directions come from the
 * same table, which is what keeps them in agreement: a wikilink the forward pass
 * writes and the reverse pass cannot read back would make every page holding an
 * internal link read-only.
 *
 * Pure data. No I/O, no Obsidian, no clock.
 */

export interface MirroredPage extends PageTarget {
  /** Vault path of the note, **without** the `.md` extension. */
  readonly path: string;
}

/** Drops the extension, since a wikilink never carries one. */
export function linkPath(notePath: string): string {
  return notePath.replace(/\.md$/i, '');
}

/**
 * Every page the vault mirrors, across every subscription (FR-4.7).
 *
 * One function rather than the same loop in each caller: the note service, the
 * push path and the sync controller all need this table, and a caller that built
 * it from a subset would silently turn some wikilinks back into URLs on push.
 *
 * `exclude` drops one subscription — used by a sync in progress, which derives its
 * own pages from the placement it is about to make rather than from the index it
 * is about to replace.
 */
export function mirroredPages(
  subscriptions: readonly Subscription[],
  stateOf: (subscriptionId: string) => SubscriptionState,
  exclude: string | null = null,
): readonly MirroredPage[] {
  const pages: MirroredPage[] = [];

  for (const subscription of subscriptions) {
    if (subscription.id === exclude) continue;

    for (const page of Object.values(stateOf(subscription.id).pages)) {
      pages.push({
        spaceKey: subscription.spaceKey,
        title: page.title,
        path: linkPath(page.localPath),
      });
    }
  }
  return pages;
}

/**
 * Keyed on the exact space and title Confluence reports.
 *
 * Deliberately not case-folded: the reverse pass has to reproduce the *original*
 * title byte for byte, and a case-insensitive match would resolve a link and then
 * write back a title Confluence never had. A title that differs in case simply
 * does not resolve, and the link stays an ordinary URL — which is correct, just
 * less useful.
 */
function key(target: PageTarget): string {
  return `${target.spaceKey}\u0000${target.title}`;
}

export class LinkIndex {
  private readonly byTarget = new Map<string, string>();
  private readonly byPath = new Map<string, PageTarget>();

  /**
   * Later entries win. The engine layers the sync in progress over what the state
   * index remembers, so a page that moved in *this* sync resolves to where it is
   * going rather than where it was.
   */
  constructor(pages: Iterable<MirroredPage>) {
    for (const page of pages) {
      const target: PageTarget = { spaceKey: page.spaceKey, title: page.title };
      this.byTarget.set(key(target), page.path);
      this.byPath.set(page.path, target);
    }
  }

  readonly resolveTarget = (target: PageTarget): string | null => {
    return this.byTarget.get(key(target)) ?? null;
  };

  readonly resolveVaultPath = (path: string): PageTarget | null => {
    return this.byPath.get(path) ?? null;
  };
}
