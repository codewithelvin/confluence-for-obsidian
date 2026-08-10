import { Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { ConfluenceSpace } from '../api/api-types';
import type { SettingsStore } from '../settings/settings-store';
import type { Subscription } from '../settings/settings-types';
import type { SyncController } from '../sync/sync-controller';
import type { AppError } from '../util/errors';
import type { Result } from '../util/result';
import { RemoveSubscriptionModal } from './remove-subscription-modal';
import { SubscriptionModal } from './subscription-modal';

/**
 * Subscription management in the settings tab (spec FR-2.2 to FR-2.7, FR-10.1).
 *
 * Presentation only — every decision is the controller's (spec §7.5).
 */

export interface SubscriptionsSectionDeps {
  readonly app: App;
  readonly store: SettingsStore;
  readonly controller: SyncController;
  readonly listSpaces: (connectionId: string) => Promise<Result<ConfluenceSpace[], AppError>>;
  readonly startSync: (subscription: Subscription) => void;
  readonly refresh: () => void;
}

function describe(subscription: Subscription, lastSyncedAt: string | null): string {
  const scope =
    subscription.rootPageId === null ? 'whole space' : `subtree of page ${subscription.rootPageId}`;
  const synced =
    lastSyncedAt === null
      ? 'never synced'
      : `last synced ${new Date(lastSyncedAt).toLocaleString()}`;

  return `${subscription.mountPath} — ${scope} — ${synced}`;
}

export class SubscriptionsSection {
  constructor(private readonly deps: SubscriptionsSectionDeps) {}

  render(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Subscriptions').setHeading();

    const { subscriptions, connections } = this.deps.store.get();
    if (subscriptions.length === 0) {
      containerEl.createDiv({
        cls: 'confluence-connection-status',
        text: 'No subscriptions yet. Subscribe to a space to mirror it into this vault.',
      });
    }

    for (const subscription of subscriptions) {
      this.renderSubscription(containerEl, subscription);
    }

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('Add subscription')
        .setCta()
        .setDisabled(connections.length === 0)
        .onClick(() => {
          this.openModal();
        }),
    );
  }

  private renderSubscription(containerEl: HTMLElement, subscription: Subscription): void {
    const connection = this.deps.controller.connectionFor(subscription);
    const suspended = this.deps.controller.status();

    new Setting(containerEl)
      .setName(`${subscription.spaceKey} (${connection?.displayName ?? 'missing connection'})`)
      .setDesc(describe(subscription, this.deps.controller.lastSyncedAt(subscription.id)))
      .addButton((button) =>
        button
          .setButtonText('Sync now')
          .setDisabled(suspended.running !== null || connection === null)
          .onClick(() => {
            this.deps.startSync(subscription);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.confirmRemoval(subscription);
          }),
      );
  }

  private confirmRemoval(subscription: Subscription): void {
    new RemoveSubscriptionModal(this.deps.app, subscription, (deleteFiles) => {
      void this.remove(subscription, deleteFiles);
    }).open();
  }

  private async remove(subscription: Subscription, deleteFiles: boolean): Promise<void> {
    const result = await this.deps.controller.remove(subscription, deleteFiles);
    if (!result.ok) {
      new Notice(result.error.userMessage, 10_000);
      return;
    }

    new Notice(
      deleteFiles
        ? `Removed ${subscription.spaceKey} and moved its folder to trash.`
        : `Removed ${subscription.spaceKey}. Its notes are still in your vault.`,
    );
    this.deps.refresh();
  }

  private openModal(): void {
    const { connections, subscriptions } = this.deps.store.get();

    new SubscriptionModal(this.deps.app, {
      connections,
      existing: subscriptions,
      listSpaces: this.deps.listSpaces,
      check: (draft) => this.deps.controller.check(draft),
      onSave: (draft) => {
        void this.create(draft);
      },
    }).open();
  }

  private async create(draft: Parameters<SyncController['create']>[0]): Promise<void> {
    const subscription = await this.deps.controller.create(draft);
    this.deps.refresh();
    new Notice(`Subscribed to ${subscription.spaceKey}. Run a sync to mirror it.`);
    this.deps.startSync(subscription);
  }
}
