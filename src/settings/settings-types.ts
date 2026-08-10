/**
 * Settings model. Types only — no runtime code, so this module is excluded from
 * coverage gates. Defaults and validation live in `settings-store.ts`.
 */

/** A configured Confluence Data Center instance (spec FR-1.1). */
export interface ConnectionProfile {
  readonly id: string;
  readonly displayName: string;
  /** Base URL including any reverse-proxy context path (spec FR-1.2). */
  readonly baseUrl: string;
}

/** A tracked {connection, space, optional root page} -> mount path mapping (spec FR-2.2). */
export interface Subscription {
  readonly id: string;
  readonly connectionId: string;
  readonly spaceKey: string;
  /** `null` subscribes to the whole space (spec FR-2.3). */
  readonly rootPageId: string | null;
  readonly mountPath: string;
  readonly syncComments: boolean;
}

export interface PluginSettings {
  readonly schemaVersion: number;
  readonly connections: readonly ConnectionProfile[];
  readonly subscriptions: readonly Subscription[];

  /** Skip attachments larger than this, leaving a placeholder link (spec FR-8.4). */
  readonly attachmentSizeLimitMb: number;
  /** Download only attachments referenced in the page body (spec FR-8.5). */
  readonly attachmentsReferencedOnly: boolean;

  /** Escape hatch for pushes that fail verification. Off by default (spec FR-5.7). */
  readonly allowForcePush: boolean;
  /** Retention for backups written before destructive local writes (spec FR-6.6). */
  readonly backupRetentionDays: number;
  /** Warn before subscribing to a subtree larger than this (spec FR-2.4). */
  readonly pageCountWarningThreshold: number;

  readonly debugLogging: boolean;
}
