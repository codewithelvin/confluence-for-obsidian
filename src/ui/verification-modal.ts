import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { PushBlocked } from '../sync/push-executor';
import type { PushedPage } from '../sync/push-service';
import { renderDiff } from './diff-view';

/**
 * What the user sees when a push fails verification (spec FR-5.2, FR-5.7).
 *
 * The diff is the point. `M₁` is what they wrote and `M₂` is what would come back
 * out of Confluence afterwards (§6.4.4 B), so the difference between the two *is*
 * the part of their edit that cannot survive the round trip — which is far more
 * actionable than any message this modal could compose.
 *
 * Force push appears only when the setting permits it, and then only behind a
 * typed confirmation (FR-5.7). It bypasses verification, not the conflict check:
 * the user may authorise losing their own unrepresentable markup, never somebody
 * else's edit.
 */

export interface VerificationModalOptions {
  /** Whether the "Allow force push" setting is on (FR-5.7). */
  readonly allowForce: boolean;
  readonly onForce: () => void;
  /**
   * Called when the modal closes without forcing, including via Escape.
   *
   * The same contract `ConfirmModal` uses: the push is waiting on the answer, and
   * dismissing the dialog is the answer "no" rather than the absence of one.
   */
  readonly onDismiss?: () => void;
  readonly onOpenInConfluence?: () => void;
}

export class VerificationFailureModal extends Modal {
  private typed = '';
  private forced = false;

  constructor(
    app: App,
    private readonly page: PushedPage,
    private readonly blocked: PushBlocked,
    private readonly options: VerificationModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('This edit cannot be pushed safely');

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('confluence-verification-modal');

    contentEl.createEl('p', { text: this.blocked.error.userMessage });
    contentEl.createEl('p', { cls: 'confluence-conflict-path', text: this.page.path });

    this.renderDifference(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.typed = '';
    this.contentEl.empty();
    if (!this.forced) this.options.onDismiss?.();
  }

  private renderDifference(contentEl: HTMLElement): void {
    const { local, roundTripped } = this.blocked;
    if (local === null || roundTripped === null) {
      // A push blocked for any other reason — a lost fragment, a degraded page —
      // has no two versions to compare, and inventing a diff would be misleading.
      return;
    }

    contentEl.createEl('p', {
      cls: 'confluence-conflict-summary',
      text:
        'Below, "your note" is what you wrote and "after a round trip" is what ' +
        'Confluence would give back. Where they differ is what would be lost.',
    });
    renderDiff(contentEl, local, roundTripped, {
      left: 'your note',
      right: 'after a round trip',
    });
  }

  private renderActions(contentEl: HTMLElement): void {
    if (this.options.onOpenInConfluence !== undefined) {
      new Setting(contentEl)
        .setName('Edit in Confluence instead')
        .setDesc('Make this change in the web editor, then sync to bring it back.')
        .addButton((button) =>
          button.setButtonText('Open in Confluence').onClick(() => {
            this.options.onOpenInConfluence?.();
            this.close();
          }),
        );
    }

    if (!this.options.allowForce) {
      new Setting(contentEl).addButton((button) =>
        button
          .setButtonText('Close')
          .setCta()
          .onClick(() => {
            this.close();
          }),
      );
      return;
    }

    this.renderForce(contentEl);
  }

  private renderForce(contentEl: HTMLElement): void {
    const required = this.page.title;

    new Setting(contentEl)
      .setName('Force push')
      .setDesc(
        'Publishes anyway. Anything shown as different above will be replaced in Confluence ' +
          `by what this plugin produced. Type the page title — ${required} — to confirm.`,
      )
      .addText((text) =>
        text.setPlaceholder(required).onChange((value) => {
          this.typed = value;
        }),
      );

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Force push')
          .setWarning()
          .onClick(() => {
            if (this.typed.trim() !== required) return;
            this.forced = true;
            this.options.onForce();
            this.close();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }
}
