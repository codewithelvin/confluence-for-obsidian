import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { Subscription } from '../settings/settings-types';

/**
 * Unsubscribing (spec FR-2.6).
 *
 * Three outcomes rather than two, because "remove" is ambiguous and the wrong
 * guess is expensive: detaching leaves the notes as ordinary Markdown, deleting
 * removes them. Neither touches Confluence — that is decision D6, and the
 * wording says so, because a user about to click a red button deserves to know
 * what it cannot do as much as what it can.
 */
export class RemoveSubscriptionModal extends Modal {
  constructor(
    app: App,
    private readonly subscription: Subscription,
    private readonly onChoose: (deleteFiles: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Remove the ${this.subscription.spaceKey} subscription`);

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      text:
        `Nothing is deleted in Confluence either way — this only affects your vault. ` +
        `The mirrored files are in "${this.subscription.mountPath}".`,
    });

    new Setting(contentEl)
      .setName('Keep the files')
      .setDesc('The notes stay in your vault as ordinary Markdown and stop syncing.')
      .addButton((button) =>
        button
          .setButtonText('Keep')
          .setCta()
          .onClick(() => {
            this.choose(false);
          }),
      );

    new Setting(contentEl)
      .setName('Delete the files')
      .setDesc('Moves the mirrored folder to trash, along with any notes you added inside it.')
      .addButton((button) =>
        button
          .setButtonText('Delete')
          .setWarning()
          .onClick(() => {
            this.choose(true);
          }),
      );

    new Setting(contentEl).addButton((button) =>
      button.setButtonText('Cancel').onClick(() => {
        this.close();
      }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private choose(deleteFiles: boolean): void {
    this.onChoose(deleteFiles);
    this.close();
  }
}
