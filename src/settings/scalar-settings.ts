import type { PluginSettings } from './settings-types';

/**
 * The settings that are a single editable scalar, described once.
 *
 * The tab renders twice over: imperatively through `display()` for Obsidian
 * before 1.13.0, and declaratively through `getSettingDefinitions()` for 1.13.0
 * and later, which is what puts them in the settings search. Two renderings of
 * one tab is the standing risk in that arrangement — they drift, and the older
 * one rots unnoticed. Naming each setting exactly once here is what stops it:
 * neither renderer holds a name, a description or a bound of its own.
 *
 * Connections and subscriptions are absent on purpose. They are collections the
 * user adds to and removes from, not scalars, so both renderers reach the same
 * imperative section code instead.
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
 * Rejects a number the imperative and declarative paths must both refuse.
 *
 * Returns the message to show, or `undefined` to accept. `display()` uses it to
 * decide whether to persist at all; the declarative control passes it straight
 * to `validate`, which surfaces the string under the field.
 */
export function validateScalarNumber(setting: ScalarSetting, value: number): string | undefined {
  if (!Number.isInteger(value)) return 'Enter a whole number.';
  if (setting.min !== undefined && value < setting.min) {
    return `Enter ${String(setting.min)} or more.`;
  }
  return undefined;
}

/**
 * Looks up the setting a declarative control key names.
 *
 * Obsidian hands `getControlValue`/`setControlValue` a bare `string`, so this
 * is what narrows it back to a key the settings actually have — and what makes
 * an unrecognised key a miss rather than a cast.
 */
export function scalarSettingFor(key: string): ScalarSetting | undefined {
  for (const group of SCALAR_SETTING_GROUPS) {
    for (const setting of group.settings) {
      if (setting.key === key) return setting;
    }
  }
  return undefined;
}

/** Reads a scalar out of the settings without widening the key to `string`. */
export function readScalar(settings: PluginSettings, key: ScalarSettingKey): number | boolean {
  return settings[key];
}
