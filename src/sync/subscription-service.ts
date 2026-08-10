import type { ConfluenceGateway } from '../api/confluence-client';
import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import { sizeWarning, type SizeWarning, type SubscriptionDraft } from './subscription-validator';

/**
 * The checks a subscription must pass before it is saved.
 *
 * This is where the second half of FR-1.7 lands. Version detection reports at
 * connection time (M1); the *refusal* belongs here rather than at connection
 * saving, because saving a connection must not require network access, and a
 * version the plugin could not detect must not block anything at all.
 */

export interface SubscriptionCheck {
  /** `null` when the server did not report a total — unknown, not zero. */
  readonly pageCount: number | null;
  /** Present when the subtree is large enough to be worth confirming (FR-2.4). */
  readonly warning: SizeWarning | null;
}

export async function checkSubscriptionTarget(
  client: ConfluenceGateway,
  draft: SubscriptionDraft,
  pageCountWarningThreshold: number,
): Promise<Result<SubscriptionCheck, AppError>> {
  const connection = await client.checkConnection();
  if (!connection.ok) return connection;

  if (!connection.value.versionSupported) {
    return err(
      new AppError(
        'VERSION_UNSUPPORTED',
        `This Confluence reports version ${connection.value.version?.raw ?? 'unknown'}. ` +
          'Personal Access Tokens were introduced in Data Center 7.9, so this instance cannot ' +
          'be synced. Ask your administrator about upgrading.',
        { action: 'open-docs' },
      ),
    );
  }

  const count = await client.countSubtree(draft.spaceKey, draft.rootPageId);
  if (!count.ok) return count;

  return ok({
    pageCount: count.value,
    warning: sizeWarning(count.value, pageCountWarningThreshold),
  });
}
