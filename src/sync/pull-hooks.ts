import type { ConfluenceGateway } from '../api/confluence-client';
import type { Subscription } from '../settings/settings-types';
import type { Logger } from '../util/logger';
import type { VaultGateway } from '../vault/vault-gateway';
import { attachmentHook } from './attachment-executor';
import { commentHook } from './comments-executor';
import type { ExecutorDeps } from './pull-executor';
import type { AttachmentState } from './sync-state';

/**
 * The one builder for a pull's attachment and comment hooks (spec FR-8.1, FR-9.3).
 *
 * Three paths pull a page: a full sync, a single-page re-pull (FR-3.8), and a "Keep
 * Remote" conflict resolution. Each used to assemble these hooks itself, and the
 * failure mode is not a crash but a difference — an image that appears on a sync and
 * vanishes on a re-pull, or a comments region that ignores the subscription's switch
 * on one path only. Same reasoning as `conversionOptionsFor`: one builder, or the
 * paths drift.
 */

export interface PullHookInputs {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly logger: Logger;
  readonly subscription: Subscription;
  /** FR-8.4's limit, in bytes. */
  readonly attachmentLimitBytes: number;
  /** FR-8.5: fetch only what the body refers to. */
  readonly attachmentsReferencedOnly: boolean;
  /** What the index already records for a page, so FR-8.3 can skip a current file. */
  readonly recorded: (pageId: string) => Readonly<Record<string, AttachmentState>>;
}

export function pullHooks(inputs: PullHookInputs): Pick<ExecutorDeps, 'attachments' | 'comments'> {
  const { client, vault, logger, subscription } = inputs;

  return {
    attachments: attachmentHook(
      {
        client,
        vault,
        logger,
        mountPath: subscription.mountPath,
        sizeLimitBytes: inputs.attachmentLimitBytes,
        referencedOnly: inputs.attachmentsReferencedOnly,
      },
      inputs.recorded,
    ),
    comments: commentHook({ client, vault, logger, enabled: subscription.syncComments }),
  };
}
