import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { Subscription } from '../settings/settings-types';
import type { ParentChoice } from '../sync/page-structure-service';

/**
 * Asking where a new page goes (spec FR-7.1, US-7).
 *
 * Two questions and no more: a title, and the page it belongs under. The parent list
 * comes from the sync index, so every option is somewhere the note can actually be
 * written — offering a page that is not mirrored would create something in Confluence
 * with no place in the vault to put it.
 */
export interface CreatePageChoice {
  readonly subscription: Subscription;
  readonly title: string;
  readonly parentId: string | null;
}

export interface CreatePageOptions {
  readonly subscriptions: readonly Subscription[];
  readonly parentsFor: (subscription: Subscription) => readonly ParentChoice[];
}

export class CreatePageModal extends Modal {
  private title = '';
  private subscription: Subscription | undefined;
  private parentId: string | null = null;

  constructor(
    app: App,
    private readonly options: CreatePageOptions,
    private readonly onCreate: (choice: CreatePageChoice) => void,
  ) {
    super(app);
    this.subscription = options.subscriptions[0];
  }

  override onOpen(): void {
    this.titleEl.setText('Create a Confluence page');

    const { contentEl } = this;
    contentEl.empty();

    if (this.subscription === undefined) {
      contentEl.createEl('p', {
        text: 'Subscribe to a space first — a new page has to belong to a mirrored space.',
      });
      return;
    }

    this.renderSpace(contentEl);
    this.renderParent(contentEl);
    this.renderTitle(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderSpace(contentEl: HTMLElement): void {
    const { subscriptions } = this.options;
    if (subscriptions.length < 2) return;

    new Setting(contentEl).setName('Space').addDropdown((dropdown) => {
      for (const subscription of subscriptions) {
        dropdown.addOption(subscription.id, `${subscription.spaceKey} (${subscription.mountPath})`);
      }
      dropdown.setValue(this.subscription?.id ?? '').onChange((id) => {
        this.subscription = subscriptions.find((candidate) => candidate.id === id);
        // The parent list belongs to the space, so it has to be rebuilt rather than
        // left showing pages from the space the user just navigated away from.
        this.parentId = null;
        this.onOpen();
      });
    });
  }

  private renderParent(contentEl: HTMLElement): void {
    const subscription = this.subscription;
    if (subscription === undefined) return;

    new Setting(contentEl)
      .setName('Under')
      .setDesc('The page the new one becomes a child of.')
      .addDropdown((dropdown) => {
        for (const choice of this.options.parentsFor(subscription)) {
          dropdown.addOption(choice.pageId ?? '', `${choice.title} — ${choice.path}`);
        }
        dropdown.setValue(this.parentId ?? '').onChange((value) => {
          this.parentId = value.length === 0 ? null : value;
        });
      });
  }

  private renderTitle(contentEl: HTMLElement): void {
    new Setting(contentEl).setName('Title').addText((text) =>
      text.setPlaceholder('Page title').onChange((value) => {
        this.title = value;
      }),
    );
  }

  private renderActions(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Create')
          .setCta()
          .onClick(() => {
            const subscription = this.subscription;
            const title = this.title.trim();
            // Silently ignored rather than warned about: an untitled page is not an
            // error the user needs explaining, it is a form they have not finished.
            if (subscription === undefined || title.length === 0) return;

            this.onCreate({ subscription, title, parentId: this.parentId });
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
