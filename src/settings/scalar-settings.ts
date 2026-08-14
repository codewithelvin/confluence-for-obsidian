/**
 * The settings that are a single editable scalar, described once.
 *
 * `display()` holds no name, description or bound of its own; it reads them
 * from here. That is worth a module on its own because these six are the part
 * of the tab Obsidian 1.13's declarative settings API can describe directly —
 * each is one row with one value — so whenever §16 O23's port happens, it has a
 * single place to read them from and cannot drift from what `display()` draws.
 *
 * Connections and subscriptions are absent on purpose, and are the reason that
 * port is still open: they are collections the user adds to and removes from,
 * which the declarative form does not express as a row.
 */

/** Keys of `PluginSettings` the user edits as a single value. */
export type ScalarSettingKey =
  | 'attachmentSizeLimitMb'
  | 'attachmentsReferencedOnly'
  | 'allowForcePush'
  | 'backupRetentionDays'
  | 'pageCountWarningThreshold'
  | 'debugLogging';

export interface ScalarSetting {
  readonly key: ScalarSettingKey;
  readonly name: string;
  readonly desc: string;
  readonly kind: 'number' | 'toggle';
  /** Smallest accepted value. Numbers only. */
  readonly min?: number;
}

export interface ScalarSettingGroup {
  readonly heading: string;
  readonly settings: readonly ScalarSetting[];
}

export const SCALAR_SETTING_GROUPS: readonly ScalarSettingGroup[] = [
  {
    heading: 'Attachments',
    settings: [
      {
        key: 'attachmentSizeLimitMb',
        name: 'Maximum attachment size (MB)',
        desc: 'Larger attachments are skipped and replaced with a placeholder link.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'attachmentsReferencedOnly',
        name: 'Only download referenced attachments',
        desc: 'Download just the files embedded in the page body. Turn off to mirror every attachment.',
        kind: 'toggle',
      },
    ],
  },
  {
    heading: 'Safety',
    settings: [
      {
        key: 'allowForcePush',
        name: 'Allow force push',
        desc:
          'Permits pushing a page that failed round-trip verification. This can destroy content ' +
          'in Confluence that the plugin could not represent. Each use still requires typed ' +
          'confirmation.',
        kind: 'toggle',
      },
      {
        key: 'backupRetentionDays',
        name: 'Backup retention (days)',
        desc: 'How long to keep the copies written before any destructive local write.',
        kind: 'number',
        min: 1,
      },
    ],
  },
  {
    heading: 'Advanced',
    settings: [
      {
        key: 'pageCountWarningThreshold',
        name: 'Large subtree warning threshold',
        desc: 'Warn before subscribing to a subtree with more pages than this.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'debugLogging',
        name: 'Debug logging',
        desc: 'Write detailed diagnostics to the developer console. Tokens are never logged.',
        kind: 'toggle',
      },
    ],
  },
];

/**
 * Rejects a number that must not be persisted.
 *
 * Returns the message describing why, or `undefined` to accept. `display()`
 * uses it to decide whether to write at all, leaving the field alone rather
 * than correcting it under the user's caret.
 */
export function validateScalarNumber(setting: ScalarSetting, value: number): string | undefined {
  if (!Number.isInteger(value)) return 'Enter a whole number.';
  if (setting.min !== undefined && value < setting.min) {
    return `Enter ${String(setting.min)} or more.`;
  }
  return undefined;
}
