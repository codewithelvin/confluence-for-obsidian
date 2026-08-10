import type { ConnectionProfile, PluginSettings, Subscription } from './settings-types';
import type { Logger } from '../util/logger';

/**
 * Settings persistence and validation.
 *
 * `data.json` is user-writable and survives downgrades, so its contents are
 * untrusted input: it may be hand-edited, corrupted by a sync tool, or written
 * by an older version. Everything loaded goes through `migrateSettings`, which
 * is pure and therefore exhaustively testable.
 */

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: PluginSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  connections: [],
  subscriptions: [],
  attachmentSizeLimitMb: 25,
  attachmentsReferencedOnly: true,
  allowForcePush: false,
  backupRetentionDays: 14,
  pageCountWarningThreshold: 1000,
  debugLogging: false,
};

export interface MigrationResult {
  readonly settings: PluginSettings;
  /** Non-fatal problems worth surfacing — e.g. a dropped malformed subscription. */
  readonly warnings: readonly string[];
}

/** Narrow persistence surface. `Plugin` satisfies this structurally, so this
 *  module never imports Obsidian and stays unit-testable. */
export interface SettingsPersistence {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseConnection(raw: unknown): ConnectionProfile | null {
  if (!isRecord(raw)) return null;
  const id = readNonEmptyString(raw['id']);
  const baseUrl = readNonEmptyString(raw['baseUrl']);
  if (id === null || baseUrl === null) return null;
  return {
    id,
    baseUrl,
    displayName: readNonEmptyString(raw['displayName']) ?? baseUrl,
  };
}

function parseSubscription(raw: unknown): Subscription | null {
  if (!isRecord(raw)) return null;
  const id = readNonEmptyString(raw['id']);
  const connectionId = readNonEmptyString(raw['connectionId']);
  const spaceKey = readNonEmptyString(raw['spaceKey']);
  const mountPath = readNonEmptyString(raw['mountPath']);
  if (id === null || connectionId === null || spaceKey === null || mountPath === null) return null;
  return {
    id,
    connectionId,
    spaceKey,
    mountPath,
    rootPageId: readNonEmptyString(raw['rootPageId']),
    syncComments: readBoolean(raw, 'syncComments', true),
  };
}

function parseList<T>(
  raw: unknown,
  parse: (item: unknown) => T | null,
  label: string,
  warnings: string[],
): readonly T[] {
  if (!Array.isArray(raw)) return [];
  const parsed: T[] = [];
  for (const item of raw) {
    const value = parse(item);
    if (value === null) {
      warnings.push(`Discarded a malformed ${label} entry from settings.`);
      continue;
    }
    parsed.push(value);
  }
  return parsed;
}

/**
 * Validates and normalises raw persisted data into settings. Never throws:
 * unusable input degrades to defaults rather than blocking plugin load.
 */
export function migrateSettings(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    return { settings: DEFAULT_SETTINGS, warnings: [] };
  }

  const warnings: string[] = [];
  const settings: PluginSettings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    connections: parseList(raw['connections'], parseConnection, 'connection', warnings),
    subscriptions: parseList(raw['subscriptions'], parseSubscription, 'subscription', warnings),
    attachmentSizeLimitMb: readNumber(raw, 'attachmentSizeLimitMb', 25, 1, 1024),
    attachmentsReferencedOnly: readBoolean(raw, 'attachmentsReferencedOnly', true),
    allowForcePush: readBoolean(raw, 'allowForcePush', false),
    backupRetentionDays: readNumber(raw, 'backupRetentionDays', 14, 1, 365),
    pageCountWarningThreshold: readNumber(raw, 'pageCountWarningThreshold', 1000, 1, 100_000),
    debugLogging: readBoolean(raw, 'debugLogging', false),
  };

  return { settings, warnings };
}

export class SettingsStore {
  private current: PluginSettings = DEFAULT_SETTINGS;

  constructor(
    private readonly persistence: SettingsPersistence,
    private readonly logger: Logger,
  ) {}

  /** Current settings. Valid before `load()` — returns defaults until then. */
  get(): PluginSettings {
    return this.current;
  }

  async load(): Promise<void> {
    const raw = await this.persistence.loadData();
    const { settings, warnings } = migrateSettings(raw);
    this.current = settings;
    for (const warning of warnings) {
      this.logger.warn(warning);
    }
  }

  /** Applies a partial change and persists it. */
  async update(patch: Partial<PluginSettings>): Promise<void> {
    this.current = { ...this.current, ...patch };
    await this.persistence.saveData(this.current);
  }

  /** Re-reads from disk after an external write (Obsidian `onExternalSettingsChange`). */
  async reload(): Promise<void> {
    await this.load();
  }
}
