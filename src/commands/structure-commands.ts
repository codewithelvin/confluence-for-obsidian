import { Notice, TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import type { Subscription } from '../settings/settings-types';
import type { SettingsStore } from '../settings/settings-store';
import { describeDemotion, type TidyPlan } from '../sync/demotion';
import type { PageStructureService } from '../sync/page-structure-service';
import { ChangePreviewModal } from '../ui/change-preview-modal';
import { ConfirmModal } from '../ui/confirm-modal';
import { CreatePageModal } from '../ui/create-page-modal';

/**
 * Create, publish, delete and tidy commands (spec FR-7.1 to FR-7.3, §6.5.4, US-7, US-8).
 *
 * Thin dispatch, like every other command module (§6.1): the modals ask, the service
 * decides, this only carries answers between them. Kept apart from
 * `register-commands` because these are the only commands that can bring a
 * Confluence page into existence, take one out of it, or move notes in bulk, and that
 * is worth being able to find in one place.
 */

export interface StructureCommandDeps {
  readonly plugin: Plugin;
  readonly store: SettingsStore;
  readonly pages: PageStructureService;
  /** Opens a note after it is created, so the user lands in the thing they asked for. */
  readonly openNote: (path: string) => void;
}

export function registerStructureCommands(deps: StructureCommandDeps): void {
  deps.plugin.addCommand({
    id: 'create-confluence-page',
    name: 'Create a page in Confluence',
    callback: () => {
      openCreate(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'publish-note-as-page',
    name: 'Publish this note as a new Confluence page',
    callback: () => {
      void publishActive(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'delete-confluence-page',
    name: 'Delete this page in Confluence',
    callback: () => {
      confirmDelete(deps);
    },
  });

  deps.plugin.addCommand({
    id: 'tidy-folder-notes',
    name: 'Tidy folder notes',
    callback: () => {
      tidy(deps);
    },
  });
}

/** A subscription and the demotions it has waiting. */
interface SubscriptionTidy {
  readonly subscription: Subscription;
  readonly plan: TidyPlan;
}

/**
 * §6.5.4's bulk demotion, across every subscription at once.
 *
 * Nothing here touches Confluence: a folder note and a leaf note are the same page,
 * differently stored, so this is purely a local tidy-up. It still asks first, because
 * it moves the user's files and rewrites the wikilinks pointing at them.
 */
function tidy(deps: StructureCommandDeps): void {
  const plans: SubscriptionTidy[] = deps.store.get().subscriptions.map((subscription) => ({
    subscription,
    plan: deps.pages.planTidy(subscription),
  }));

  const ops = plans.flatMap((entry) => entry.plan.ops);
  const blocked = plans.flatMap((entry) => entry.plan.rejected);

  if (ops.length === 0) {
    const first = blocked[0];
    new Notice(
      first === undefined
        ? 'Nothing to tidy — every folder note still has children.'
        : `${String(blocked.length)} folder note(s) cannot be tidied. "${first.title}": ${first.reason}`,
      first === undefined ? 5000 : 12_000,
    );
    return;
  }

  new ChangePreviewModal(
    deps.plugin.app,
    {
      title: `Tidy ${String(ops.length)} folder note(s)?`,
      intro:
        'These pages no longer have children, so their notes can move back out of their ' +
        'folders. Nothing changes in Confluence — the pages are untouched, and links to ' +
        'the notes are rewritten for you.',
      lines: ops.map((op) => ({ subject: op.from, detail: describeDemotion(op) })),
      confirmText: 'Tidy them',
    },
    (apply) => {
      if (apply) void applyTidy(deps, plans, blocked.length);
    },
  ).open();
}

async function applyTidy(
  deps: StructureCommandDeps,
  plans: readonly SubscriptionTidy[],
  blocked: number,
): Promise<void> {
  let demoted = 0;
  const failures: string[] = [];

  for (const { subscription, plan } of plans) {
    if (plan.ops.length === 0) continue;

    const outcome = await deps.pages.applyTidy(subscription, plan.ops);
    demoted += outcome.demoted.length;
    failures.push(...outcome.failures.map((failure) => `"${failure.title}": ${failure.reason}`));
  }

  const blockedNote = blocked === 0 ? '' : ` ${String(blocked)} could not be tidied.`;
  new Notice(
    failures.length === 0
      ? `Tidied ${String(demoted)} folder note(s).${blockedNote}`
      : `Tidied ${String(demoted)}; ${String(failures.length)} failed. ${failures[0] ?? ''}`,
    failures.length === 0 ? 5000 : 12_000,
  );
}

/** The note the user is looking at, or `null` if it is not a Markdown file. */
function activeNote(deps: StructureCommandDeps): TFile | null {
  const file = deps.plugin.app.workspace.getActiveFile();
  return file instanceof TFile && file.extension === 'md' ? file : null;
}

function openCreate(deps: StructureCommandDeps): void {
  const { subscriptions } = deps.store.get();

  new CreatePageModal(
    deps.plugin.app,
    { subscriptions, parentsFor: (subscription) => deps.pages.parentChoices(subscription) },
    (choice) => {
      void create(deps, choice.subscription, choice.title, choice.parentId);
    },
  ).open();
}

async function create(
  deps: StructureCommandDeps,
  subscription: Subscription,
  title: string,
  parentId: string | null,
): Promise<void> {
  const created = await deps.pages.createPage({ subscription, title, parentId });
  if (!created.ok) {
    new Notice(created.error.userMessage, 10_000);
    return;
  }

  new Notice(`Created "${created.value.title}" in ${subscription.spaceKey}.`);
  deps.openNote(created.value.localPath);
}

async function publishActive(deps: StructureCommandDeps): Promise<void> {
  const file = activeNote(deps);
  if (file === null) {
    new Notice('Open the note you want to publish first.');
    return;
  }

  const created = await deps.pages.promoteNote(file.path);
  new Notice(
    created.ok ? `Published "${created.value.title}" to Confluence.` : created.error.userMessage,
    created.ok ? 5000 : 12_000,
  );
}

/**
 * FR-7.3's typed confirmation.
 *
 * The exact title has to be typed. This is the one command in the plugin that removes
 * something from a corporate wiki, and the friction is the point: a mistyped title
 * simply does nothing.
 */
function confirmDelete(deps: StructureCommandDeps): void {
  const file = activeNote(deps);
  if (file === null) {
    new Notice('Open the Confluence note you want to delete first.');
    return;
  }

  const title = file.basename;
  new ConfirmModal(
    deps.plugin.app,
    {
      title: 'Delete this page in Confluence?',
      body:
        `"${title}" will be moved to the Confluence trash and its note removed from this ` +
        'vault. An administrator can restore it from the trash; this plugin cannot.',
      confirmText: 'Delete in Confluence',
      destructive: true,
      requireTyped: title,
    },
    () => {
      void remove(deps, file.path, title);
    },
  ).open();
}

async function remove(deps: StructureCommandDeps, path: string, title: string): Promise<void> {
  const deleted = await deps.pages.deletePage(path);
  new Notice(
    deleted.ok ? `Deleted "${title}" in Confluence.` : deleted.error.userMessage,
    deleted.ok ? 5000 : 12_000,
  );
}
