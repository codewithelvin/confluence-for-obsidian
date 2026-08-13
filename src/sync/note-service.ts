import type { ConfluenceGateway } from '../api/confluence-client';
import type { FragmentMap } from '../convert/types';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import type { BackupStore } from './backup-store';
import type { FragmentStore } from './fragment-store';
import { locateNote, subscriptionFor } from './note-locator';
import { pullSinglePage, type SinglePagePull } from './pull-executor';
import { singlePageExecutor } from './single-page-deps';
import type { PageState, SyncStateStore } from './sync-state';

/**
 * What the plugin can do with *one note* (spec FR-3.8, FR-4.5, FR-10.5).
 *
 * Split from `SyncController`, which owns *when a whole subscription syncs*. The
 * two share dependencies but not a question: this one always starts from a path
 * in the vault and works outwards to the page behind it.
 */

export interface NoteServiceDeps {
  readonly settings: SettingsStore;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly state: SyncStateStore;
  readonly backups: BackupStore;
  readonly logger: Logger;
  readonly createClient: (connection: ConnectionProfile) => ConfluenceGateway;
  readonly now: () => string;
}

/**
 * Whether a path is the `Title/Title.md` form (decision D9).
 *
 * Only used when the index has no record of the note — otherwise the recorded
 * flag wins, because it is what stops an automatic demotion.
 */
export function isFolderNotePath(path: string): boolean {
  const folder = parentPath(path);
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return folder.slice(folder.lastIndexOf('/') + 1) === name;
}

export class NoteService {
  constructor(private readonly deps: NoteServiceDeps) {}

  /** The subscription whose mount contains a note, or `null` for a personal note. */
  subscriptionFor(notePath: string): Subscription | null {
    return subscriptionFor(this.deps.settings.get().subscriptions, notePath);
  }

  /** The Confluence URL recorded in a note's frontmatter (spec FR-10.5). */
  pageUrlFor(notePath: string): string | null {
    const identity = this.deps.vault.readIdentity(notePath);
    if (identity === null) return null;
    return identity.url.length === 0 ? null : identity.url;
  }

  /**
   * The preserved fragments behind a note's placeholders, for the renderer
   * (spec FR-4.5).
   *
   * Empty for a note with no Confluence identity or no cached fragments — a
   * placeholder with nothing behind it still renders, it just cannot say what it
   * stands for.
   */
  async fragmentsFor(notePath: string): Promise<FragmentMap> {
    const identity = this.deps.vault.readIdentity(notePath);
    if (identity === null) return new Map();

    const loaded = await this.deps.fragments.load(identity.id);
    if (!loaded.ok || loaded.value === null) return new Map();
    return loaded.value.fragments;
  }

  /**
   * Re-pulls the page behind one note (spec FR-3.8).
   *
   * Deliberately not routed through the full sync: the point of the command is
   * to refresh *this* page without waiting for an enumeration of the space.
   */
  async pullPage(notePath: string): Promise<Result<SinglePagePull, AppError>> {
    const target = locateNote(this.deps, notePath);
    if (!target.ok) return target;

    const { subscription, connection, pageId, previous } = target.value;

    const backed = await this.backUpIfModified(notePath, previous);
    if (backed !== null) return err(backed);

    const pulled = await pullSinglePage(
      singlePageExecutor(this.deps, subscription, connection, this.deps.createClient(connection)),
      pageId,
      {
        path: notePath,
        isFolderNote: previous?.isFolderNote ?? isFolderNotePath(notePath),
        alias: previous?.alias ?? null,
        labels: previous?.labels ?? [],
      },
    );
    if (!pulled.ok) return pulled;

    await this.record(subscription.id, pulled.value.state);
    return pulled;
  }

  /**
   * Writes an orphan's note back from Confluence (spec FR-7.4).
   *
   * Distinct from `pullPage`, which starts from a file: an orphan has no file, so
   * there is no frontmatter to read an identity out of and nothing to back up. The
   * recorded path, folder-note shape and alias are taken from the index, which still
   * remembers all three from the sync that wrote the note in the first place.
   */
  async restoreOrphan(
    subscription: Subscription,
    pageId: string,
  ): Promise<Result<PageState, AppError>> {
    const connection = this.deps.settings
      .get()
      .connections.find((candidate) => candidate.id === subscription.connectionId);
    if (connection === undefined) {
      return err(
        new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.', {
          action: 'open-settings',
        }),
      );
    }

    const previous = this.deps.state.forSubscription(subscription.id).pages[pageId];
    if (previous === undefined) {
      return err(new AppError('NOT_FOUND', 'That page is no longer in the sync index.'));
    }

    const pulled = await pullSinglePage(
      singlePageExecutor(this.deps, subscription, connection, this.deps.createClient(connection)),
      pageId,
      {
        path: previous.localPath,
        isFolderNote: previous.isFolderNote,
        alias: previous.alias,
        labels: previous.labels,
      },
    );
    if (!pulled.ok) return pulled;

    await this.record(subscription.id, pulled.value.state);
    return ok(pulled.value.state);
  }

  /**
   * Copies the note aside when a re-pull is about to discard local edits (FR-6.6).
   *
   * A single-page pull is a destructive local write like any other, and it is the
   * one the user reaches for *while editing*. An unmodified note is not backed up:
   * every re-pull would otherwise leave a copy of a file identical to the one
   * already on disk, and the retention window would fill with them.
   */
  private async backUpIfModified(
    notePath: string,
    previous: PageState | undefined,
  ): Promise<AppError | null> {
    const content = await this.deps.vault.read(notePath);
    // No file yet, or unreadable: there is nothing to lose, and the pull itself
    // will report a write failure if the path is genuinely unusable.
    if (!content.ok) return null;

    if (previous !== undefined && (await sha256(content.value)) === previous.localHash) return null;

    const saved = await this.deps.backups.save(notePath, content.value);
    return saved.ok ? null : saved.error;
  }

  private async record(subscriptionId: string, page: PageState): Promise<void> {
    const current = this.deps.state.forSubscription(subscriptionId);
    await this.deps.state.replace(subscriptionId, {
      ...current,
      pages: { ...current.pages, [page.pageId]: page },
    });
  }
}
