import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { ConfluenceSpace } from '../api/api-types';

/** Rows rendered at once. A large instance can hold thousands of spaces. */
const MAX_VISIBLE = 100;

/**
 * Filters spaces by key or name, case-insensitively. Pure and exported so the
 * matching rules are testable without a DOM.
 */
export function filterSpaces(
  spaces: readonly ConfluenceSpace[],
  query: string,
): readonly ConfluenceSpace[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return spaces;

  return spaces.filter(
    (space) =>
      space.key.toLowerCase().includes(needle) || space.name.toLowerCase().includes(needle),
  );
}

export class SpaceBrowserModal extends Modal {
  private filter = '';
  private listEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly spaces: readonly ConfluenceSpace[],
    private readonly onChoose: (space: ConfluenceSpace) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('Confluence spaces');

    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl).setName('Filter').addText((text) =>
      text.setPlaceholder('Search by name or key').onChange((value) => {
        this.filter = value;
        this.renderList();
      }),
    );

    this.listEl = contentEl.createDiv({ cls: 'confluence-space-list' });
    this.renderList();
  }

  override onClose(): void {
    this.listEl = null;
    this.contentEl.empty();
  }

  private renderList(): void {
    const list = this.listEl;
    if (list === null) return;
    list.empty();

    const matches = filterSpaces(this.spaces, this.filter);
    if (matches.length === 0) {
      list.createDiv({ text: 'No spaces match that filter.', cls: 'confluence-space-empty' });
      return;
    }

    for (const space of matches.slice(0, MAX_VISIBLE)) {
      new Setting(list)
        .setName(space.name)
        .setDesc(space.key)
        .addButton((button) =>
          button
            .setButtonText('Select')
            .setCta()
            .onClick(() => {
              this.onChoose(space);
              this.close();
            }),
        );
    }

    // Never truncate silently — say what was hidden and how to reach it.
    if (matches.length > MAX_VISIBLE) {
      list.createDiv({
        text: `Showing ${String(MAX_VISIBLE)} of ${String(matches.length)} spaces. Narrow the filter to see the rest.`,
        cls: 'confluence-space-empty',
      });
    }
  }
}
