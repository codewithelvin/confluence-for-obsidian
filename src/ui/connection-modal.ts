import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { normaliseBaseUrl } from '../api/endpoints';

/**
 * Add or edit a Confluence connection.
 *
 * Presentation only (spec §7.5): URL validation lives in `normaliseBaseUrl`,
 * and the token is handed to the caller rather than stored here.
 */

export interface ConnectionDraft {
  readonly displayName: string;
  /** Already normalised — safe to persist as-is. */
  readonly baseUrl: string;
  /** Empty means "keep the token already stored for this connection". */
  readonly token: string;
}

export interface ConnectionModalInitial {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly hasStoredToken?: boolean;
}

export class ConnectionModal extends Modal {
  private displayName: string;
  private rawBaseUrl: string;
  private token = '';

  constructor(
    app: App,
    private readonly initial: ConnectionModalInitial,
    private readonly onSubmit: (draft: ConnectionDraft) => void,
  ) {
    super(app);
    this.displayName = initial.displayName ?? '';
    this.rawBaseUrl = initial.baseUrl ?? '';
  }

  override onOpen(): void {
    const isEdit = this.initial.baseUrl !== undefined;
    this.titleEl.setText(isEdit ? 'Edit Confluence connection' : 'Add Confluence connection');

    const { contentEl } = this;
    contentEl.empty();
    this.renderFields(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    // Drop the token from memory the moment the dialog is dismissed.
    this.token = '';
    this.contentEl.empty();
  }

  private renderFields(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .setName('Name')
      .setDesc('How this connection appears in settings.')
      .addText((text) =>
        text
          .setPlaceholder('Corporate wiki')
          .setValue(this.displayName)
          .onChange((value) => {
            this.displayName = value;
          }),
      );

    new Setting(contentEl)
      .setName('Base URL')
      .setDesc('The address of your Confluence site, including any path such as /confluence.')
      .addText((text) =>
        text
          .setPlaceholder('https://wiki.example.com/confluence')
          .setValue(this.rawBaseUrl)
          .onChange((value) => {
            this.rawBaseUrl = value;
          }),
      );

    new Setting(contentEl)
      .setName('Personal Access Token')
      .setDesc(
        this.initial.hasStoredToken === true
          ? 'A token is already stored. Leave blank to keep it.'
          : 'Create one in Confluence under Profile → Personal Access Tokens. Requires Confluence 7.9 or later.',
      )
      .addText((text) => {
        text.setPlaceholder('Paste your token').onChange((value) => {
          this.token = value;
        });
        text.inputEl.type = 'password';
      });
  }

  private renderActions(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Save')
          .setCta()
          .onClick(() => {
            this.submit();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }

  private submit(): void {
    const normalised = normaliseBaseUrl(this.rawBaseUrl);
    if (!normalised.ok) {
      new Notice(normalised.error.userMessage);
      return;
    }

    if (this.token.trim().length === 0 && this.initial.hasStoredToken !== true) {
      new Notice('Enter a Personal Access Token.');
      return;
    }

    const name = this.displayName.trim();
    this.onSubmit({
      displayName: name.length > 0 ? name : normalised.value,
      baseUrl: normalised.value,
      token: this.token.trim(),
    });
    this.close();
  }
}
