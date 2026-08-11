import type { ConfluencePageRef } from '../api/api-types';
import { AppError } from '../util/errors';
import { err, ok, type Result } from '../util/result';
import type { SyncRequest } from './sync-engine';
import type { SyncCallbacks } from './sync-types';

/**
 * The two steps a sync takes before it decides anything (spec §6.6.2 steps 1–2).
 *
 * Free functions rather than methods: neither reads the engine's own state, both are
 * about the *request*, and keeping them here leaves the engine reading as §6.6.2's
 * algorithm rather than as that algorithm plus its preliminaries.
 */

/** Verifies credentials and version before anything is written (§6.6.2 step 1). */
export async function preflight(
  request: SyncRequest,
  callbacks: SyncCallbacks,
): Promise<Result<void, AppError>> {
  callbacks.onProgress?.({
    phase: 'preflight',
    done: 0,
    total: null,
    detail: 'Checking the connection',
  });

  const check = await request.client.checkConnection();
  if (!check.ok) return check;

  if (!check.value.versionSupported) {
    return err(
      new AppError(
        'VERSION_UNSUPPORTED',
        `This Confluence is version ${check.value.version?.raw ?? 'unknown'}. Personal Access ` +
          'Tokens need Data Center 7.9 or newer, so this connection cannot be synced.',
        { action: 'open-docs' },
      ),
    );
  }
  return ok(undefined);
}

export async function discover(
  request: SyncRequest,
  callbacks: SyncCallbacks,
): Promise<Result<readonly ConfluencePageRef[], AppError>> {
  callbacks.onProgress?.({
    phase: 'discovering',
    done: 0,
    total: null,
    detail: request.subscription.spaceKey,
  });

  const options = {
    onProgress: (collected: number) => {
      callbacks.onProgress?.({
        phase: 'discovering',
        done: collected,
        total: null,
        detail: `${String(collected)} pages found`,
      });
    },
    ...(callbacks.isCancelled === undefined ? {} : { isCancelled: callbacks.isCancelled }),
  };

  return request.client.listSubtree(
    request.subscription.spaceKey,
    request.subscription.rootPageId,
    options,
  );
}
