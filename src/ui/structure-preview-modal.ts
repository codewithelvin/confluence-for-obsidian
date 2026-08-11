import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { describeStructureOp, type StructureOp } from '../sync/structure-planner';

/**
 * The preview FR-7.8 requires in front of any structural change.
 *
 * Every line is a change to somebody else's documentation, so the modal shows the
 * whole list before anything is sent — not a count, and not one prompt per page. A
 * user who dragged a folder of forty notes needs to see that forty pages are about to
 * move, which a running total of confirmations cannot tell them.
 *
 * Dismissing it is a decision: `onDismiss` resolves the sync's question as "no",
 * because a sync waiting on an answer nobody gave would hang.
 */
export interface StructurePreviewOptions {
  readonly ops: readonly StructureOp[];
  readonly spaceKey: string;
}

export class StructurePreviewModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly options: StructurePreviewOptions,
    private readonly onAnswer: (apply: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { ops, spaceKey } = this.options;
    this.titleEl.setText(`Apply ${String(ops.length)} change(s) to ${spaceKey}?`);

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      text:
        'You moved or renamed these notes in Obsidian. Applying will rename and reparent the ' +
        'pages in Confluence to match. Nothing is sent until you choose Apply.',
    });

    const list = contentEl.createEl('ul', { cls: 'confluence-structure-preview' });
    for (const op of ops) {
      // `createEl` with text rather than any form of markup: these strings carry page
      // titles, which are Confluence content and therefore untrusted (§7.4).
      const item = list.createEl('li');
      item.createEl('strong', { text: op.notePath });
      item.appendText(` — ${describeStructureOp(op)}`);
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Apply in Confluence')
          .setCta()
          .onClick(() => {
            this.answer(true);
          }),
      )
      .addButton((button) =>
        button.setButtonText('Not now').onClick(() => {
          this.answer(false);
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissal is "no". The sync is waiting on this answer.
    if (!this.answered) {
      this.answered = true;
      this.onAnswer(false);
    }
  }

  private answer(apply: boolean): void {
    this.answered = true;
    this.onAnswer(apply);
    this.close();
  }
}
