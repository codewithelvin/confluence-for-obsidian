import { Modal, Notice, Setting } from 'obsidian';
import type { App, TextComponent } from 'obsidian';
import type { ConfluenceSpace } from '../api/api-types';
import type { ConnectionProfile, Subscription } from '../settings/settings-types';
import type { SubscriptionCheck } from '../sync/subscription-service';
import {
  normaliseMountPath,
  validateSubscription,
  type SubscriptionDraft,
} from '../sync/subscription-validator';
import type { AppError } from '../util/errors';
import type { Result } from '../util/result';
import { ConfirmModal } from './confirm-modal';
import { SpaceBrowserModal } from './space-browser-modal';

/**
 * Creating a subscription (spec FR-2.2 to FR-2.5).
 *
 * Presentation only: validation, the version gate and the size warning are all
 * decided elsewhere and only rendered here (spec §7.5).
 */

export interface SubscriptionModalDeps {
  readonly connections: readonly ConnectionProfile[];
  readonly existing: readonly Subscription[];
  readonly listSpaces: (connectionId: string) => Promise<Result<ConfluenceSpace[], AppError>>;
  readonly check: (draft: SubscriptionDraft) => Promise<Result<SubscriptionCheck, AppError>>;
  readonly onSave: (draft: SubscriptionDraft) => void;
}

export class SubscriptionModal extends Modal {
  private connectionId: string;
  private spaceKey = '';
  private spaceName = '';
  private rootPageId = '';
  /**
   * The mount folder *is* the space folder (D13), so it defaults to the space
   * key and follows the chosen space until the user types a folder of their own.
   * Defaulting to a `Confluence/` parent is what produced `EP/EP/…`.
   */
  private mountPath = '';
  private mountEdited = false;
  private mountInput: TextComponent | null = null;
  private spaceEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly deps: SubscriptionModalDeps,
  ) {
    super(app);
    this.connectionId = deps.connections[0]?.id ?? '';
  }

  override onOpen(): void {
    this.titleEl.setText('Subscribe to a Confluence space');

    const { contentEl } = this;
    contentEl.empty();

    if (this.deps.connections.length === 0) {
      contentEl.createEl('p', {
        text: 'Add a Confluence connection first — a subscription needs somewhere to sync from.',
      });
      return;
    }

    this.renderConnection(contentEl);
    this.renderSpace(contentEl);
    this.renderScope(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.spaceEl = null;
    this.contentEl.empty();
  }

  private renderConnection(contentEl: HTMLElement): void {
    new Setting(contentEl).setName('Connection').addDropdown((dropdown) => {
      for (const connection of this.deps.connections) {
        dropdown.addOption(connection.id, connection.displayName);
      }
      dropdown.setValue(this.connectionId).onChange((value) => {
        this.connectionId = value;
        // The space belongs to the old instance and almost certainly does not
        // exist on the new one.
        this.spaceKey = '';
        this.spaceName = '';
        this.renderSpaceName();
      });
    });
  }

  private renderSpace(contentEl: HTMLElement): void {
    const setting = new Setting(contentEl)
      .setName('Space')
      .setDesc('The Confluence space to mirror.')
      .addButton((button) =>
        button.setButtonText('Choose space').onClick(() => {
          void this.chooseSpace();
        }),
      );

    this.spaceEl = setting.descEl;
    this.renderSpaceName();
  }

  private renderSpaceName(): void {
    this.spaceEl?.setText(
      this.spaceKey.length === 0
        ? 'The Confluence space to mirror.'
        : `${this.spaceName} (${this.spaceKey})`,
    );
  }

  private renderScope(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName('Root page ID')
      .setDesc('Leave empty to mirror the whole space, or paste a page ID to mirror its subtree.')
      .addText((text) =>
        text.setPlaceholder('Optional').onChange((value) => {
          this.rootPageId = value.trim();
        }),
      );

    new Setting(contentEl)
      .setName('Vault folder')
      .setDesc(
        'This folder is the space: the space home page becomes its note and the tree starts ' +
          'inside it. Defaults to the space key. It must not overlap another subscription.',
      )
      .addText((text) => {
        this.mountInput = text;
        text.setPlaceholder('EP').setValue(this.mountPath);
        text.onChange((value) => {
          this.mountPath = value;
          this.mountEdited = value.trim().length > 0;
        });
      });
  }

  private renderActions(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Subscribe')
          .setCta()
          .onClick(() => {
            void this.save();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }

  private async chooseSpace(): Promise<void> {
    const spaces = await this.deps.listSpaces(this.connectionId);
    if (!spaces.ok) {
      new Notice(spaces.error.userMessage, 10_000);
      return;
    }

    new SpaceBrowserModal(this.app, spaces.value, (space) => {
      this.spaceKey = space.key;
      this.spaceName = space.name;
      this.renderSpaceName();

      if (this.mountEdited) return;
      this.mountPath = space.key;
      this.mountInput?.setValue(space.key);
    }).open();
  }

  private draft(): SubscriptionDraft {
    return {
      connectionId: this.connectionId,
      spaceKey: this.spaceKey,
      rootPageId: this.rootPageId.length === 0 ? null : this.rootPageId,
      mountPath: normaliseMountPath(this.mountPath),
    };
  }

  private async save(): Promise<void> {
    const draft = this.draft();

    const invalid = validateSubscription(draft, this.deps.existing);
    if (invalid !== null) {
      new Notice(invalid.userMessage, 10_000);
      return;
    }

    const checked = await this.deps.check(draft);
    if (!checked.ok) {
      new Notice(checked.error.userMessage, 15_000);
      return;
    }

    const warning = checked.value.warning;
    if (warning === null) {
      this.commit(draft);
      return;
    }

    new ConfirmModal(
      this.app,
      { title: 'Large space', body: warning.message, confirmText: 'Subscribe anyway' },
      () => {
        this.commit(draft);
      },
    ).open();
  }

  private commit(draft: SubscriptionDraft): void {
    this.deps.onSave(draft);
    this.close();
  }
}
