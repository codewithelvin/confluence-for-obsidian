import type { App } from 'obsidian';
import type { LocalPage } from '../sync/pull-planner';
import { describeStructureOp, type StructureOp } from '../sync/structure-planner';
import { ChangePreviewModal } from './change-preview-modal';
import { ConfirmModal } from './confirm-modal';

/**
 * The questions a *sync* has to ask, as modals (spec FR-3.5, FR-7.8).
 *
 * Alongside `push-prompts`, and for the same reason: the composition root wires
 * services to the UI, and should not also be where the wording of a destructive
 * prompt lives.
 *
 * Both default to **no** when dismissed. One would delete the user's files and the
 * other would reorganise a corporate wiki, and a prompt clicked away is not consent.
 */

/** Asked before any locally-mirrored note is trashed (FR-3.5). */
export function askAboutDeletions(app: App): (pages: readonly LocalPage[]) => Promise<boolean> {
  return (pages) =>
    new Promise((resolve) => {
      const paths = pages.map((page) => page.path);

      new ConfirmModal(
        app,
        {
          title: 'Pages deleted in Confluence',
          body:
            `${String(paths.length)} page(s) no longer exist in Confluence. Move their notes to ` +
            `trash?\n\n${paths.slice(0, 20).join('\n')}`,
          confirmText: 'Move to trash',
          destructive: true,
          onDismiss: () => {
            resolve(false);
          },
        },
        () => {
          resolve(true);
        },
      ).open();
    });
}

/** FR-7.8's preview: the whole list of structural changes before any is sent. */
export function askAboutStructure(
  app: App,
  spaceKey: string,
): (ops: readonly StructureOp[]) => Promise<boolean> {
  return (ops) =>
    new Promise((resolve) => {
      new ChangePreviewModal(
        app,
        {
          title: `Apply ${String(ops.length)} change(s) to ${spaceKey}?`,
          intro:
            'You moved or renamed these notes in Obsidian. Applying will rename and reparent ' +
            'the pages in Confluence to match. Nothing is sent until you choose Apply.',
          lines: ops.map((op) => ({ subject: op.notePath, detail: describeStructureOp(op) })),
          confirmText: 'Apply in Confluence',
        },
        (apply) => {
          resolve(apply);
        },
      ).open();
    });
}
