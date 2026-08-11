import type { ConfluenceGateway } from '../api/confluence-client';
import type { FragmentMap } from '../convert/types';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import type { Logger } from '../util/logger';
import { err, type Result } from '../util/result';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import { attachmentHook } from './attachment-executor';
import type { FragmentStore } from './fragment-store';
import { LinkIndex, linkPath, type MirroredPage } from './link-index';
import { pullSinglePage, type ExecutorDeps } from './pull-executor';
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
    return (
      this.deps.settings
        .get()
        .subscriptions.find(
          (subscription) =>
            notePath === subscription.mountPath ||
            notePath.startsWith(`${subscription.mountPath}/`),
        ) ?? null
    );
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
  async pullPage(notePath: string): Promise<Result<PageState, AppError>> {
    const target = this.resolve(notePath);
    if (!target.ok) return target;

    const { subscription, connection, pageId, previous } = target.value;
    const pulled = await pullSinglePage(this.executorFor(subscription, connection), pageId, {
      path: notePath,
      isFolderNote: previous?.isFolderNote ?? isFolderNotePath(notePath),
      alias: previous?.alias ?? null,
    });
    if (!pulled.ok) return pulled;

    await this.record(subscription.id, pulled.value);
    return pulled;
  }

  /** Everything a single-page pull needs to know about where the note belongs. */
  private resolve(notePath: string): Result<
    {
      subscription: Subscription;
      connection: ConnectionProfile;
      pageId: string;
      previous: PageState | undefined;
    },
    AppError
  > {
    const subscription = this.subscriptionFor(notePath);
    if (subscription === null) {
      return err(
        new AppError('OUT_OF_MOUNT', 'This note is not inside a Confluence subscription.'),
      );
    }

    const identity = this.deps.vault.readIdentity(notePath);
    if (identity === null) {
      return err(
        new AppError('NOT_FOUND', 'This note has no Confluence page recorded in its frontmatter.'),
      );
    }

    const connection =
      this.deps.settings
        .get()
        .connections.find((candidate) => candidate.id === subscription.connectionId) ?? null;
    if (connection === null) {
      return err(
        new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.', {
          action: 'open-settings',
        }),
      );
    }

    return {
      ok: true,
      value: {
        subscription,
        connection,
        pageId: identity.id,
        previous: this.deps.state.forSubscription(subscription.id).pages[identity.id],
      },
    };
  }

  /**
   * Executor dependencies for a single-page pull.
   *
   * Link resolution spans *every* subscription, its own included: a single-page
   * pull recomputes no paths, so the index is exactly right about all of them.
   */
  private executorFor(subscription: Subscription, connection: ConnectionProfile): ExecutorDeps {
    const client = this.deps.createClient(connection);
    const linkIndex = new LinkIndex(this.mirrored());
    const settings = this.deps.settings.get();

    return {
      client,
      vault: this.deps.vault,
      fragments: this.deps.fragments,
      logger: this.deps.logger,
      baseUrl: connection.baseUrl,
      strictMarkup: connection.strictMarkup,
      resolveTarget: linkIndex.resolveTarget,
      resolveVaultPath: linkIndex.resolveVaultPath,
      attachments: attachmentHook(
        {
          client,
          vault: this.deps.vault,
          logger: this.deps.logger,
          mountPath: subscription.mountPath,
          sizeLimitBytes: settings.attachmentSizeLimitMb * 1_048_576,
          referencedOnly: settings.attachmentsReferencedOnly,
        },
        (pageId) =>
          this.deps.state.forSubscription(subscription.id).pages[pageId]?.attachments ?? {},
      ),
      now: this.deps.now,
    };
  }

  /** Every mirrored page, across every subscription (FR-4.7). */
  private mirrored(): readonly MirroredPage[] {
    const pages: MirroredPage[] = [];

    for (const subscription of this.deps.settings.get().subscriptions) {
      for (const page of Object.values(this.deps.state.forSubscription(subscription.id).pages)) {
        pages.push({
          spaceKey: subscription.spaceKey,
          title: page.title,
          path: linkPath(page.localPath),
        });
      }
    }
    return pages;
  }

  private async record(subscriptionId: string, page: PageState): Promise<void> {
    const current = this.deps.state.forSubscription(subscriptionId);
    await this.deps.state.replace(subscriptionId, {
      ...current,
      pages: { ...current.pages, [page.pageId]: page },
    });
  }
}
