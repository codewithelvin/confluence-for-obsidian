import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { ConflictChoice, ConflictDecision } from '../sync/conflict-executor';
import type { PageConflict } from '../sync/push-executor';
import { renderDiff } from './diff-view';

/**
 * The conflict modal (spec FR-6.2, FR-6.3, FR-6.5, decision D4).
 *
 * Three choices and no fourth: D4 rules out merging, so the modal's whole job is
 * to make the difference legible enough that the user can pick one with confidence.
 *
 * Conflicts arrive as a batch and are walked one at a time, with an "apply to all"
 * for the common case where a whole subtree diverged the same way (FR-6.5).
 * Dismissing the modal answers nothing — every unanswered conflict is left alone,
 * which is the only response that cannot lose either side's work.
 */

interface ChoiceButton {
  readonly choice: ConflictChoice;
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
}

const CHOICES: readonly ChoiceButton[] = [
  {
    choice: 'keep-local',
    label: 'Keep local',
    description: 'Publish this note, superseding the Confluence version.',
    destructive: false,
  },
  {
    choice: 'keep-remote',
    label: 'Keep remote',
    description: 'Replace this note with the Confluence version. A backup is kept first.',
    destructive: true,
  },
  {
    choice: 'save-both',
    label: 'Save both',
    description: 'Leave the note alone and write the Confluence version beside it.',
    destructive: false,
  },
];

function formatTimestamp(iso: string): string {
  if (iso.length === 0) return 'an unrecorded time';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export class ConflictModal extends Modal {
  private index = 0;
  private applyToAll = false;
  private readonly decisions: ConflictDecision[] = [];
  private reported = false;

  constructor(
    app: App,
    private readonly conflicts: readonly PageConflict[],
    private readonly onDone: (decisions: readonly ConflictDecision[]) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
    // Reported exactly once, whether the user answered everything or pressed
    // Escape: the caller is awaiting this and would otherwise wait forever.
    if (this.reported) return;
    this.reported = true;
    this.onDone(this.decisions);
  }

  private current(): PageConflict | undefined {
    return this.conflicts[this.index];
  }

  private render(): void {
    const conflict = this.current();
    if (conflict === undefined) {
      this.close();
      return;
    }

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('confluence-conflict-modal');

    this.titleEl.setText(
      this.conflicts.length === 1
        ? 'Changed here and in Confluence'
        : `Changed here and in Confluence (${String(this.index + 1)} of ${String(this.conflicts.length)})`,
    );

    contentEl.createEl('p', {
      cls: 'confluence-conflict-summary',
      text:
        `"${conflict.title}" was edited in Confluence by ` +
        `${conflict.remoteUpdatedBy.length === 0 ? 'somebody else' : conflict.remoteUpdatedBy} ` +
        `at ${formatTimestamp(conflict.remoteUpdatedAt)} — version ` +
        `${String(conflict.remoteVersion)} — and it has also changed here.`,
    });
    contentEl.createEl('p', { cls: 'confluence-conflict-path', text: conflict.path });

    renderDiff(contentEl, conflict.localBody, conflict.remoteBody, {
      left: 'this note',
      right: `Confluence v${String(conflict.remoteVersion)}`,
    });

    this.renderChoices(contentEl);
  }

  private renderChoices(contentEl: HTMLElement): void {
    if (this.index < this.conflicts.length - 1) {
      new Setting(contentEl)
        .setName('Apply my next choice to every remaining conflict')
        .setDesc('Use this when the whole subtree diverged the same way.')
        .addToggle((toggle) =>
          toggle.setValue(this.applyToAll).onChange((value) => {
            this.applyToAll = value;
          }),
        );
    }

    for (const option of CHOICES) {
      new Setting(contentEl)
        .setName(option.label)
        .setDesc(option.description)
        .addButton((button) => {
          button.setButtonText(option.label).onClick(() => {
            this.choose(option.choice);
          });
          if (option.destructive) button.setWarning();
          else button.setCta();
        });
    }

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(this.index < this.conflicts.length - 1 ? 'Decide later' : 'Close')
        .onClick(() => {
          this.choose('skip');
        }),
    );
  }

  /**
   * Records the answer and moves on.
   *
   * `skip` is recorded as a decision rather than dropped, so the caller can tell
   * "the user looked and chose to leave it" from "the user never saw it".
   */
  private choose(choice: ConflictChoice): void {
    const conflict = this.current();
    if (conflict === undefined) return;

    if (this.applyToAll) {
      for (const remaining of this.conflicts.slice(this.index)) {
        this.decisions.push({ conflict: remaining, choice });
      }
      this.index = this.conflicts.length;
    } else {
      this.decisions.push({ conflict, choice });
      this.index += 1;
    }

    this.render();
  }
}
