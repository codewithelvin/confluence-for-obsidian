import type { SettingsStore } from '../settings/settings-store';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import type { VaultGateway } from '../vault/vault-gateway';
import type { PageState, SyncStateStore } from './sync-state';

/**
 * From a path in the vault to the Confluence page behind it.
 *
 * Shared by everything that starts from *one note* — re-pull (FR-3.8), open in
 * Confluence (FR-10.5), push (FR-5.6). Each of them needs the same four answers
 * and the same four refusals, and a second copy of this would eventually disagree
 * with the first about which subscription a nested mount belongs to.
 */

export interface LocatorDeps {
  readonly settings: SettingsStore;
  readonly vault: VaultGateway;
  readonly state: SyncStateStore;
}

export interface LocatedNote {
  readonly subscription: Subscription;
  readonly connection: ConnectionProfile;
  readonly pageId: string;
  /** The index record, or `undefined` for a note whose entry was lost. */
  readonly previous: PageState | undefined;
}

/**
 * The subscription whose mount contains a note, or `null` for a personal note.
 *
 * Longest mount first, so a subscription nested inside another's *folder* — which
 * FR-2.5 rejects at creation but a hand-edited `data.json` can still produce —
 * resolves to the inner one rather than whichever happens to be listed first.
 */
export function subscriptionFor(
  subscriptions: readonly Subscription[],
  notePath: string,
): Subscription | null {
  return (
    [...subscriptions]
      .sort((a, b) => b.mountPath.length - a.mountPath.length)
      .find(
        (subscription) =>
          notePath === subscription.mountPath || notePath.startsWith(`${subscription.mountPath}/`),
      ) ?? null
  );
}

export function locateNote(deps: LocatorDeps, notePath: string): Result<LocatedNote, AppError> {
  const settings = deps.settings.get();

  const subscription = subscriptionFor(settings.subscriptions, notePath);
  if (subscription === null) {
    return err(new AppError('OUT_OF_MOUNT', 'This note is not inside a Confluence subscription.'));
  }

  const identity = deps.vault.readIdentity(notePath);
  if (identity === null) {
    return err(
      new AppError('NOT_FOUND', 'This note has no Confluence page recorded in its frontmatter.'),
    );
  }

  const connection =
    settings.connections.find((candidate) => candidate.id === subscription.connectionId) ?? null;
  if (connection === null) {
    return err(
      new AppError('CREDENTIALS_UNAVAILABLE', 'That connection no longer exists.', {
        action: 'open-settings',
      }),
    );
  }

  return ok({
    subscription,
    connection,
    pageId: identity.id,
    previous: deps.state.forSubscription(subscription.id).pages[identity.id],
  });
}
