import { ItemView, Setting } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { SettingsStore } from '../settings/settings-store';
import type { Subscription } from '../settings/settings-types';
import type { SyncController } from '../sync/sync-controller';
import type { LocalPage } from '../sync/pull-planner';
import { describeStructureOp } from '../sync/structure-planner';
import type { SuspensionRegistry } from '../sync/suspension';
import type { SyncReport } from '../sync/sync-types';

/**
 * The Sync Panel (spec FR-10.2).
 *
 * A pure view over the controller: what is running, what the last sync did, and
 * everything it wants a decision about — conflicts, orphans, untracked files,
 * failures. It holds no state of its own beyond the DOM.
 */

export const SYNC_PANEL_VIEW_TYPE = 'confluence-sync-panel';

export interface SyncPanelDeps {
  readonly store: SettingsStore;
  readonly controller: SyncController;
  readonly suspensions: SuspensionRegistry;
  readonly startSync: (subscription: Subscription) => void;
  /**
   * FR-7.4's two answers to an orphan: write the note back, or delete the page.
   *
   * Both belong here rather than on a command, because an orphan has no note to run
   * a command *on* — the panel is the only place it exists.
   */
  readonly restoreOrphan: (subscription: Subscription, page: LocalPage) => void;
  readonly deleteOrphan: (subscription: Subscription, page: LocalPage) => void;
}

/**
 * How many paths a group lists before it stops.
 *
 * A space the size of EP produces hundreds of read-only pages and hundreds of
 * untracked files, and printing every path turned the panel into a scroll of
 * filenames with the counts — the part anyone acts on — pushed off the top. The
 * count in the title is the report; the paths are a sample of it.
 */
const LIST_LIMIT = 8;

/** A named group of note paths, rendered only when it has members. */
export function renderList(parent: HTMLElement, title: string, items: readonly string[]): void {
  if (items.length === 0) return;

  const group = parent.createDiv({ cls: 'confluence-panel-group' });
  group.createDiv({
    cls: 'confluence-panel-group-title',
    text: `${title} (${String(items.length)})`,
  });

  const list = group.createEl('ul', { cls: 'confluence-panel-list' });
  for (const item of items.slice(0, LIST_LIMIT)) list.createEl('li', { text: item });

  const hidden = items.length - LIST_LIMIT;
  if (hidden > 0) {
    group.createDiv({
      cls: 'confluence-panel-more',
      text: `…and ${String(hidden)} more.`,
    });
  }
}

function summaryOf(report: SyncReport): string {
  const parts = [
    `${String(report.pulled)} pulled`,
    `${String(report.relocated)} moved`,
    `${String(report.deleted)} deleted`,
    `${String(report.unchanged)} unchanged`,
  ];

  const pushed = report.conflictsResolved.filter((outcome) => outcome.choice === 'keep-local');
  if (pushed.length > 0) parts.push(`${String(pushed.length)} pushed`);

  // Only when there were any: a zero on a space nobody comments on is a column of
  // noise on every report forever.
  if (report.commentsPulled > 0) parts.push(`${String(report.commentsPulled)} comments`);

  return parts.join(' · ');
}

/**
 * Conflicts the user has not settled.
 *
 * A conflict that was resolved is history; one that was skipped, or whose
 * resolution failed, is still a decision waiting to be made and belongs in the
 * panel until it is (FR-10.2).
 */
function unresolved(report: SyncReport): readonly string[] {
  const settled = new Set(
    report.conflictsResolved
      .filter((outcome) => outcome.choice !== 'skip' && outcome.error === null)
      .map((outcome) => outcome.pageId),
  );
  return report.conflicts.filter((page) => !settled.has(page.pageId)).map((page) => page.path);
}

/**
 * Everything to do with conflicts (FR-6.2, FR-6.4).
 *
 * The conflict-copy group is the answer to §16 **O6**: a "Save Both" snapshot is
 * kept until the user deletes it, so the panel is where it stays visible rather
 * than quietly accumulating in the mount.
 */
function renderConflicts(parent: HTMLElement, report: SyncReport): void {
  renderList(parent, 'Conflicts — changed here and in Confluence', unresolved(report));
  renderList(
    parent,
    'Conflict copies — delete them once merged',
    report.conflictsResolved.flatMap((outcome) =>
      outcome.copyPath === null ? [] : [outcome.copyPath],
    ),
  );
  renderList(
    parent,
    'Conflict resolutions that failed',
    report.conflictsResolved.flatMap((outcome) =>
      outcome.error === null ? [] : [`${outcome.title}: ${outcome.error.userMessage}`],
    ),
  );
}

/** FR-7.4's two answers, bound to the subscription the report belongs to. */
interface OrphanActions {
  readonly restore: (page: LocalPage) => void;
  readonly remove: (page: LocalPage) => void;
}

/**
 * Orphans, each with the two things that can be done about it (FR-7.4).
 *
 * A row per orphan rather than a path list, because this is the one group in the panel
 * the user cannot act on anywhere else: the note is gone, so there is no file to run a
 * command against.
 */
function renderOrphans(
  parent: HTMLElement,
  orphans: readonly LocalPage[],
  actions: OrphanActions,
): void {
  if (orphans.length === 0) return;

  const group = parent.createDiv({ cls: 'confluence-panel-group' });
  group.createDiv({
    cls: 'confluence-panel-group-title',
    text: `Orphans — note deleted, page still there (${String(orphans.length)})`,
  });

  for (const page of orphans.slice(0, LIST_LIMIT)) {
    new Setting(group)
      .setName(page.title)
      .setDesc(page.path)
      .addButton((button) =>
        button.setButtonText('Restore note').onClick(() => {
          actions.restore(page);
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Delete page')
          .setWarning()
          .onClick(() => {
            actions.remove(page);
          }),
      );
  }

  const hidden = orphans.length - LIST_LIMIT;
  if (hidden > 0) {
    group.createDiv({ cls: 'confluence-panel-more', text: `…and ${String(hidden)} more.` });
  }
}

/**
 * What the user's own rearranging produced (FR-7.4 to FR-7.8).
 *
 * Its own group of lists because the four states are genuinely different answers:
 * applied, waiting to be confirmed, refused, and "this note is somewhere else".
 */
function renderStructure(parent: HTMLElement, report: SyncReport, orphans: OrphanActions): void {
  renderOrphans(parent, report.orphans, orphans);
  // Kept apart from the orphans above: this note is not gone, it is somewhere the
  // plugin does not manage, and nothing about it should be offered for deletion (FR-7.7).
  renderList(
    parent,
    'Moved out of the mount — not synced',
    report.misplaced.map((page) => `${page.title} — now at ${page.foundAt}`),
  );
  renderList(
    parent,
    'Rearranged in Confluence to match your folders',
    report.structural.map((op) => `${op.notePath} — ${describeStructureOp(op)}`),
  );
  renderList(
    parent,
    'Rearrangements waiting for your confirmation',
    report.structuralDeclined.map((op) => `${op.notePath} — ${describeStructureOp(op)}`),
  );
  renderList(
    parent,
    'Rearrangements that cannot be applied',
    report.structuralRejected.map((item) => `${item.path} — ${item.reason}`),
  );
}

function renderReport(parent: HTMLElement, report: SyncReport, orphans: OrphanActions): void {
  parent.createDiv({ cls: 'confluence-panel-summary', text: summaryOf(report) });

  if (report.cancelled) {
    parent.createDiv({ cls: 'confluence-panel-warning', text: 'The last sync was cancelled.' });
  }

  renderConflicts(parent, report);
  renderList(
    parent,
    'Edited locally — push when ready',
    report.localEdits.map((page) => page.path),
  );
  renderList(
    parent,
    'Read-only (could not round-trip)',
    report.degraded.map((page) => page.path),
  );
  renderStructure(parent, report, orphans);
  renderList(parent, 'Untracked files in the mount', [...report.untracked]);
  renderList(
    parent,
    'Names shortened to fit the path limit',
    report.truncated.map((p) => p.path),
  );
  renderList(
    parent,
    'Could not be given a valid path',
    report.unmappable.map((page) => `${page.title} — ${page.reason}`),
  );
  // Collected since M4 and never shown, which is how a page displaying five of its
  // seventeen screenshots came to look identical to one whose download had not
  // finished. Both reasons a file can be absent are worth reading: over the size limit
  // is a setting the user controls, and missing from Confluence is damage they can
  // repair at the source, after which the picture appears with no change here (FR-8.9).
  renderList(
    parent,
    'Attachments not downloaded',
    report.skippedAttachments.map((item) => `${item.filename} — ${item.reason}`),
  );
  renderList(
    parent,
    'Failed',
    report.failures.map((failure) => `${failure.title}: ${failure.error.userMessage}`),
  );
}

export class SyncPanelView extends ItemView {
  private stopListening: (() => void)[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: SyncPanelDeps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return SYNC_PANEL_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Confluence sync';
  }

  override getIcon(): string {
    return 'refresh-cw';
  }

  override onOpen(): Promise<void> {
    this.stopListening = [
      this.deps.controller.onChange(() => {
        this.render();
      }),
      this.deps.suspensions.onChange(() => {
        this.render();
      }),
    ];
    this.render();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    for (const stop of this.stopListening) stop();
    this.stopListening = [];
    this.contentEl.empty();
    return Promise.resolve();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('confluence-sync-panel');

    this.renderSuspensions(contentEl);

    const { subscriptions } = this.deps.store.get();
    if (subscriptions.length === 0) {
      contentEl.createDiv({
        cls: 'confluence-panel-empty',
        text: 'No subscriptions yet. Add one in the plugin settings.',
      });
      return;
    }

    for (const subscription of subscriptions) this.renderSubscription(contentEl, subscription);
  }

  /** The persistent notice an authentication failure leaves behind (FR-1.8). */
  private renderSuspensions(contentEl: HTMLElement): void {
    for (const suspension of this.deps.suspensions.all()) {
      const connection = this.deps.store
        .get()
        .connections.find((candidate) => candidate.id === suspension.connectionId);

      contentEl.createDiv({
        cls: 'confluence-panel-error',
        text:
          `Sync is suspended for ${connection?.displayName ?? 'a connection'}: ` +
          `${suspension.reason} Update the token in settings to resume.`,
      });
    }
  }

  private renderSubscription(contentEl: HTMLElement, subscription: Subscription): void {
    const status = this.deps.controller.status();
    const running = status.running?.id === subscription.id;
    const section = contentEl.createDiv({ cls: 'confluence-panel-section' });

    new Setting(section)
      .setName(subscription.spaceKey)
      .setDesc(this.subtitle(subscription, running))
      .addButton((button) => {
        if (running) {
          button.setButtonText('Cancel').onClick(() => {
            this.deps.controller.cancel();
          });
          return;
        }
        button
          .setButtonText('Sync')
          .setCta()
          .setDisabled(status.running !== null)
          .onClick(() => {
            this.deps.startSync(subscription);
          });
      });

    const report = status.reports.get(subscription.id);
    if (report !== undefined) {
      renderReport(section, report, {
        restore: (page) => {
          this.deps.restoreOrphan(subscription, page);
        },
        remove: (page) => {
          this.deps.deleteOrphan(subscription, page);
        },
      });
    }
  }

  private subtitle(subscription: Subscription, running: boolean): string {
    if (running) {
      const progress = this.deps.controller.status().progress;
      if (progress === null) return 'Starting…';
      const total = progress.total === null ? '' : ` of ${String(progress.total)}`;
      return `${progress.detail} — ${String(progress.done)}${total}`;
    }

    const last = this.deps.controller.lastSyncedAt(subscription.id);
    return last === null ? 'Never synced' : `Last synced ${new Date(last).toLocaleString()}`;
  }
}
