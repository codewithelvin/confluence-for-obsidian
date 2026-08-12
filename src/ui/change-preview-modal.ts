import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

/**
 * The preview FR-7.8 requires in front of any structural change.
 *
 * Every line is a change to somebody else's documentation, or to the user's own
 * files, so the modal shows the whole list before anything happens — not a count,
 * and not one prompt per page. A user who dragged a folder of forty notes needs to
 * see that forty pages are about to move, which a running total of confirmations
 * cannot tell them.
 *
 * Deliberately generic over what the list *is*: the sync's remote reparenting and
 * the `Tidy folder notes` command's local moves (§6.5.4) ask the same question, and
 * a second modal saying it differently would be a second chance to word it badly.
 *
 * Dismissing it is a decision: `onAnswer(false)`, because a caller waiting on an
 * answer nobody gave would hang.
 */

/** One row of the preview: what is affected, and what will happen to it. */
export interface PreviewLine {
  readonly subject: string;
  readonly detail: string;
}

export interface ChangePreviewOptions {
  readonly title: string;
  readonly intro: string;
  readonly lines: readonly PreviewLine[];
  readonly confirmText: string;
}

export class ChangePreviewModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly options: ChangePreviewOptions,
    private readonly onAnswer: (apply: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: this.options.intro });

    const list = contentEl.createEl('ul', { cls: 'confluence-structure-preview' });
    for (const line of this.options.lines) {
      // `createEl` with text rather than any form of markup: these strings carry page
      // titles, which are Confluence content and therefore untrusted (§7.4).
      const item = list.createEl('li');
      item.createEl('strong', { text: line.subject });
      item.appendText(` — ${line.detail}`);
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(this.options.confirmText)
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
    // Dismissal is "no". The caller is waiting on this answer.
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
