import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

/**
 * A yes/no confirmation.
 *
 * `requireTyped` demands the user type an exact phrase before confirming. That
 * is reserved for irreversible remote actions such as deleting a Confluence
 * page (spec FR-7.3) — routine confirmations should not use it, or the
 * friction stops being a signal.
 */
export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  readonly confirmText?: string;
  readonly destructive?: boolean;
  readonly requireTyped?: string;
}

export class ConfirmModal extends Modal {
  private typed = '';

  constructor(
    app: App,
    private readonly options: ConfirmOptions,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: this.options.body });

    const required = this.options.requireTyped;
    if (required !== undefined) {
      new Setting(contentEl).setName(`Type "${required}" to confirm`).addText((text) =>
        text.onChange((value) => {
          this.typed = value;
        }),
      );
    }

    this.renderActions(contentEl, required);
  }

  override onClose(): void {
    this.typed = '';
    this.contentEl.empty();
  }

  private renderActions(contentEl: HTMLElement, required: string | undefined): void {
    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(this.options.confirmText ?? 'Confirm').onClick(() => {
          if (required !== undefined && this.typed.trim() !== required) return;
          this.onConfirm();
          this.close();
        });
        if (this.options.destructive === true) button.setWarning();
        else button.setCta();
      })
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }
}
