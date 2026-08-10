import type { SyncController } from '../sync/sync-controller';
import type { SuspensionRegistry } from '../sync/suspension';

/**
 * The status bar item (spec FR-10.3).
 *
 * Shows what sync is doing, or when it last ran; clicking opens the Sync Panel.
 * Text only — no markup is built from any Confluence-derived string (§7.4).
 */

export interface StatusBarDeps {
  readonly element: HTMLElement;
  readonly controller: SyncController;
  readonly suspensions: SuspensionRegistry;
  readonly subscriptionIds: () => readonly string[];
  readonly onClick: () => void;
}

/** The one line the status bar shows. Pure, so the wording is testable. */
export function statusText(
  progressDetail: string | null,
  suspended: number,
  lastSyncedAt: string | null,
): string {
  if (progressDetail !== null) return `Confluence: ${progressDetail}`;
  if (suspended > 0) return 'Confluence: sync suspended';
  if (lastSyncedAt === null) return 'Confluence: not synced';
  return `Confluence: synced ${new Date(lastSyncedAt).toLocaleTimeString()}`;
}

export class StatusBar {
  private stopListening: (() => void)[] = [];

  constructor(private readonly deps: StatusBarDeps) {}

  start(): void {
    this.deps.element.addClass('mod-clickable');
    this.deps.element.addEventListener('click', this.deps.onClick);

    this.stopListening = [
      this.deps.controller.onChange(() => {
        this.render();
      }),
      this.deps.suspensions.onChange(() => {
        this.render();
      }),
    ];
    this.render();
  }

  stop(): void {
    for (const stop of this.stopListening) stop();
    this.stopListening = [];
    this.deps.element.removeEventListener('click', this.deps.onClick);
  }

  render(): void {
    const status = this.deps.controller.status();
    const detail = status.running === null ? null : (status.progress?.detail ?? 'starting');

    this.deps.element.setText(
      statusText(detail, this.deps.suspensions.all().length, this.mostRecentSync()),
    );
  }

  /** The newest sync across all subscriptions — the one a user would call "last sync". */
  private mostRecentSync(): string | null {
    const times = this.deps
      .subscriptionIds()
      .map((id) => this.deps.controller.lastSyncedAt(id))
      .filter((value): value is string => value !== null)
      .sort();

    return times[times.length - 1] ?? null;
  }
}
