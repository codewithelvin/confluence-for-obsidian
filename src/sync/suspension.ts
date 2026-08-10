import type { AppError } from '../util/errors';

/**
 * Sync suspension after an authentication failure (spec FR-1.8).
 *
 * A 401 or 403 is never transient in the way a timeout is: the token has been
 * revoked, has expired, or never had the rights. Retrying it on a schedule
 * would lock the account out and bury the real message under repeated
 * notices, so all sync for that connection stops until the credentials change.
 */

export interface Suspension {
  readonly connectionId: string;
  readonly reason: string;
  readonly at: string;
}

/** Errors that mean "stop", not "try again". */
export function isSuspendingError(error: AppError): boolean {
  return error.code === 'AUTH_FAILED' || error.code === 'VERSION_UNSUPPORTED';
}

export class SuspensionRegistry {
  private readonly suspended = new Map<string, Suspension>();
  private readonly listeners = new Set<() => void>();

  get(connectionId: string): Suspension | null {
    return this.suspended.get(connectionId) ?? null;
  }

  all(): readonly Suspension[] {
    return [...this.suspended.values()];
  }

  suspend(connectionId: string, reason: string, at: string): void {
    this.suspended.set(connectionId, { connectionId, reason, at });
    this.notify();
  }

  /** Called when the user saves a new token, so the next sync is allowed to try. */
  clear(connectionId: string): void {
    if (this.suspended.delete(connectionId)) this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
