import type { ConfluenceGateway } from '../api/confluence-client';
import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import type { Logger } from '../util/logger';
import type { VaultGateway } from '../vault/vault-gateway';
import type { FragmentStore } from './fragment-store';
import { LinkIndex, mirroredPages } from './link-index';
import type { ExecutorDeps } from './pull-executor';
import { pullHooks } from './pull-hooks';
import type { SyncStateStore } from './sync-state';

/**
 * Executor dependencies for an operation on **one page**.
 *
 * Three paths pull a single page: the FR-3.8 re-pull, a "Keep Remote" resolution, and
 * a page that has just been created (FR-7.1, FR-7.2). Each was building this itself,
 * and by the third copy the risk was no longer hypothetical — the same reasoning as
 * `conversionOptionsFor` and `pullHooks`. One builder, so the three cannot disagree
 * about what a pull of one page means.
 *
 * Link resolution deliberately spans *every* subscription, this one included: a
 * single-page operation recomputes no paths, so the index is exactly right about all
 * of them (FR-4.7).
 */

export interface SinglePageDeps {
  readonly settings: SettingsStore;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly state: SyncStateStore;
  readonly logger: Logger;
  readonly now: () => string;
}

export function singlePageExecutor(
  deps: SinglePageDeps,
  subscription: Subscription,
  connection: ConnectionProfile,
  client: ConfluenceGateway,
): ExecutorDeps {
  const settings = deps.settings.get();
  const links = new LinkIndex(
    mirroredPages(settings.subscriptions, (id) => deps.state.forSubscription(id)),
  );

  return {
    client,
    vault: deps.vault,
    fragments: deps.fragments,
    logger: deps.logger,
    baseUrl: connection.baseUrl,
    strictMarkup: connection.strictMarkup,
    resolveTarget: links.resolveTarget,
    resolveVaultPath: links.resolveVaultPath,
    ...pullHooks({
      client,
      vault: deps.vault,
      logger: deps.logger,
      subscription,
      attachmentLimitBytes: settings.attachmentSizeLimitMb * 1_048_576,
      attachmentsReferencedOnly: settings.attachmentsReferencedOnly,
      recorded: (pageId) =>
        deps.state.forSubscription(subscription.id).pages[pageId]?.attachments ?? {},
    }),
    now: deps.now,
  };
}
