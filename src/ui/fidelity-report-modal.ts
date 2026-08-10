import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { formatFidelityReport } from '../diagnostics/fidelity-report';
import type { FidelityReport } from '../diagnostics/fidelity-probe';

/**
 * Shows the result of a fidelity probe.
 *
 * The summary is on screen; the full report — including the storage format of
 * pages that failed — goes to the clipboard, because that is what makes a
 * failure diagnosable rather than merely visible.
 */
export class FidelityReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: FidelityReport,
    private readonly baseUrl: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Conversion fidelity — space ${this.report.spaceKey}`);

    const { contentEl } = this;
    contentEl.empty();

    this.renderSummary(contentEl);
    this.renderFailures(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderSummary(contentEl: HTMLElement): void {
    const { sampled, certified, degraded, unreadable } = this.report;
    contentEl.createEl('p', {
      text: `Sampled ${String(sampled)} pages: ${String(certified)} editable, ${String(degraded)} read-only, ${String(unreadable)} unreadable.`,
    });

    const observations = contentEl.createDiv({ cls: 'confluence-space-list' });
    const wrapped = this.report.observations.tableCellsWithParagraphs;
    const bare = this.report.observations.tableCellsBare;

    new Setting(observations)
      .setName('Table cell form')
      .setDesc(
        wrapped > 0 && bare === 0
          ? 'Cells wrap content in <p>. The converter writes bare cells, so table pages are read-only until that is changed.'
          : `Wrapped in <p>: ${String(wrapped)} · bare: ${String(bare)}`,
      );

    new Setting(observations)
      .setName('Inline comment markers')
      .setDesc(
        `${String(this.report.observations.withInlineComments)} pages — each of these is read-only.`,
      );
  }

  private renderFailures(contentEl: HTMLElement): void {
    const failures = this.report.pages.filter((page) => page.outcome !== 'certified');
    if (failures.length === 0) return;

    const list = contentEl.createDiv({ cls: 'confluence-space-list' });
    for (const page of failures.slice(0, 20)) {
      new Setting(list).setName(page.title).setDesc(`${page.outcome} — ${page.id}`);
    }
  }

  private renderActions(contentEl: HTMLElement): void {
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Copy full report')
          .setCta()
          .onClick(() => {
            void this.copyReport();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Close').onClick(() => {
          this.close();
        }),
      );
  }

  private async copyReport(): Promise<void> {
    const markdown = formatFidelityReport(this.report, this.baseUrl);
    try {
      await navigator.clipboard.writeText(markdown);
      new Notice('Fidelity report copied to the clipboard.');
    } catch {
      new Notice('Could not access the clipboard.');
    }
  }
}
