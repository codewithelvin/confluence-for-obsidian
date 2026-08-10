import { asFiniteNumber, asNonEmptyString, asString, isRecord } from '../util/guards';
import type { Fidelity } from '../vault/frontmatter';
import type { StateGateway } from '../vault/state-gateway';
import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';

/**
 * The sync state index (spec §6.6.1).
 *
 * Authoritative bookkeeping: what was synced, at which remote version, to which
 * path, and what the bytes hashed to on both sides. Frontmatter carries the
 * *portable* identity; this carries what frontmatter cannot, and if it is lost
 * it is rebuilt by rescanning frontmatter and re-pulling.
 *
 * Written through `StateGateway`, which replaces the file atomically — a
 * truncated index is worse than a missing one, because a missing one is
 * obviously missing.
 */

export const STATE_SCHEMA_VERSION = 1;

/** Per-page record, spec §6.6.1. */
export interface PageState {
  readonly pageId: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly remoteVersion: number;
  readonly localPath: string;
  /**
   * Whether the page is stored as `Title/Title.md` (decision D9).
   *
   * Recorded rather than derived from the path, because it is what stops a page
   * that loses its last child from being demoted automatically — §6.5.4 makes
   * demotion an explicit command, so that adding and removing one child does
   * not move a whole subtree twice.
   */
  readonly isFolderNote: boolean;
  /** sha256 of the local file as last written or last seen unchanged. */
  readonly localHash: string;
  /** sha256 of the last-synced remote storage body. */
  readonly storageHash: string;
  readonly fidelity: Fidelity;
  readonly lastSyncedAt: string;
}

export interface SubscriptionState {
  /** ISO-8601, or `null` if the subscription has never completed a sync. */
  readonly lastSyncedAt: string | null;
  readonly pages: Readonly<Record<string, PageState>>;
}

export interface SyncIndex {
  readonly schemaVersion: number;
  readonly subscriptions: Readonly<Record<string, SubscriptionState>>;
}

export const EMPTY_SUBSCRIPTION: SubscriptionState = { lastSyncedAt: null, pages: {} };

export function emptyIndex(): SyncIndex {
  return { schemaVersion: STATE_SCHEMA_VERSION, subscriptions: {} };
}

function parsePageState(raw: unknown): PageState | null {
  if (!isRecord(raw)) return null;

  const pageId = asNonEmptyString(raw['pageId']);
  const localPath = asNonEmptyString(raw['localPath']);
  if (pageId === null || localPath === null) return null;

  return {
    pageId,
    localPath,
    isFolderNote: raw['isFolderNote'] === true,
    title: asString(raw['title']) ?? '',
    parentId: asNonEmptyString(raw['parentId']),
    remoteVersion: asFiniteNumber(raw['remoteVersion']) ?? 0,
    localHash: asString(raw['localHash']) ?? '',
    storageHash: asString(raw['storageHash']) ?? '',
    fidelity: raw['fidelity'] === 'degraded' ? 'degraded' : 'certified',
    lastSyncedAt: asString(raw['lastSyncedAt']) ?? '',
  };
}

function parseSubscriptionState(raw: unknown): SubscriptionState {
  if (!isRecord(raw)) return EMPTY_SUBSCRIPTION;

  const pages: Record<string, PageState> = {};
  const rawPages = raw['pages'];
  if (isRecord(rawPages)) {
    for (const [pageId, value] of Object.entries(rawPages)) {
      const state = parsePageState(value);
      // A record that cannot be read is dropped rather than repaired: the page
      // is then treated as new and pulled again, which is always safe.
      if (state !== null) pages[pageId] = state;
    }
  }

  return { lastSyncedAt: asNonEmptyString(raw['lastSyncedAt']), pages };
}

/**
 * Validates a persisted index. Never throws: an unreadable index degrades to an
 * empty one, which costs a full re-pull but never blocks the plugin.
 */
export function parseIndex(raw: unknown): SyncIndex {
  if (!isRecord(raw)) return emptyIndex();

  const subscriptions: Record<string, SubscriptionState> = {};
  const rawSubscriptions = raw['subscriptions'];
  if (isRecord(rawSubscriptions)) {
    for (const [id, value] of Object.entries(rawSubscriptions)) {
      subscriptions[id] = parseSubscriptionState(value);
    }
  }

  return { schemaVersion: STATE_SCHEMA_VERSION, subscriptions };
}

const INDEX_FILE = 'index.json';

/**
 * Loads, holds and persists the index.
 *
 * The index is replaced rather than mutated (spec §7.2), so a sync that fails
 * part way cannot leave a half-updated record behind in memory.
 */
export class SyncStateStore {
  private index: SyncIndex = emptyIndex();

  constructor(private readonly state: StateGateway) {}

  get(): SyncIndex {
    return this.index;
  }

  forSubscription(subscriptionId: string): SubscriptionState {
    return this.index.subscriptions[subscriptionId] ?? EMPTY_SUBSCRIPTION;
  }

  async load(): Promise<Result<void, AppError>> {
    const raw = await this.state.read(INDEX_FILE);
    if (!raw.ok) return raw;

    if (raw.value === null) {
      this.index = emptyIndex();
      return ok(undefined);
    }

    try {
      this.index = parseIndex(JSON.parse(raw.value));
    } catch {
      // Corrupt JSON: start empty. Every page is then re-pulled, and the pull
      // recognises its own notes by frontmatter rather than duplicating them.
      this.index = emptyIndex();
    }
    return ok(undefined);
  }

  /** Replaces one subscription's record and persists the whole index atomically. */
  async replace(subscriptionId: string, state: SubscriptionState): Promise<Result<void, AppError>> {
    this.index = {
      ...this.index,
      subscriptions: { ...this.index.subscriptions, [subscriptionId]: state },
    };
    return this.persist();
  }

  /** Drops a subscription's record — used when the user unsubscribes (FR-2.6). */
  async forget(subscriptionId: string): Promise<Result<void, AppError>> {
    const { [subscriptionId]: _removed, ...rest } = this.index.subscriptions;
    this.index = { ...this.index, subscriptions: rest };
    return this.persist();
  }

  private async persist(): Promise<Result<void, AppError>> {
    return this.state.write(INDEX_FILE, `${JSON.stringify(this.index, null, 2)}\n`);
  }
}
