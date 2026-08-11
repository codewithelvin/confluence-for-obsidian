import type { ConfluencePage } from '../api/api-types';
import type { ConfluenceGateway } from '../api/confluence-client';
import { unresolvedEmbeds } from '../convert/embed-scan';
import { verify } from '../convert/round-trip-verifier';
import { storageToMarkdown } from '../convert/storage-to-markdown';
import type { ConversionOptions, FragmentMap } from '../convert/types';
import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import type { Logger } from '../util/logger';
import { err, ok, type Result } from '../util/result';
import { pageUrl, splitFrontmatter, type ConfluenceIdentity } from '../vault/frontmatter';
import type { VaultGateway } from '../vault/vault-gateway';
import { conversionOptionsFor, type ConversionInputs } from './conversion-options';
import type { FragmentStore } from './fragment-store';
import { applyLabels } from './label-push';
import { stripManagedRegions } from './managed-regions';
import type { AttachmentState, PageState } from './sync-state';
import { planUploads, runUploads, type UploadPlan } from './upload-executor';

/**
 * Writing one page back to Confluence (spec §3.5, §6.4.4 B).
 *
 * Every gate the spec puts in front of a push is here, in this order, and each
 * one refuses rather than guesses:
 *
 *   1. the page must be certified               (FR-5.3)
 *   2. its preserved fragments must still exist (§6.4.3 rule 4)
 *   3. the edit must survive a round trip       (FR-5.2)
 *   4. the remote version must be the one we last saw (FR-6.1, FR-6.2)
 *
 * Only then does anything leave the machine. The one bypass is `force`, which
 * FR-5.7 gates behind a setting *and* a typed confirmation, and which skips
 * exactly step 3 — never the conflict check, because overwriting a colleague's
 * edit is not the user's to authorise.
 */

export interface PushDeps extends ConversionInputs {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly logger: Logger;
  readonly now: () => string;
}

/** The state the push starts from: what the index remembers about the page. */
export interface PushTarget {
  readonly state: PageState;
  readonly spaceKey: string;
}

/** A page that moved on remotely while it was being edited here (FR-6.1). */
export interface PageConflict {
  readonly pageId: string;
  readonly title: string;
  readonly path: string;
  /** Local body, managed regions stripped — the left side of the diff (FR-6.3). */
  readonly localBody: string;
  /** Remote body as Markdown, so the diff reads in the user's own format. */
  readonly remoteBody: string;
  readonly remoteStorage: string;
  readonly remoteVersion: number;
  readonly remoteUpdatedAt: string;
  readonly remoteUpdatedBy: string;
}

/** Why a push did not happen, with the material the UI needs to explain it. */
export interface PushBlocked {
  readonly error: AppError;
  /**
   * The user's Markdown and what it became after a round trip, when
   * verification is what blocked the push (FR-5.2). `null` for every other
   * reason, where there is nothing to compare.
   */
  readonly local: string | null;
  readonly roundTripped: string | null;
}

export type PushOutcome =
  | {
      readonly kind: 'pushed';
      readonly state: PageState;
      /**
       * What did not go with the body, on a push that otherwise succeeded.
       *
       * A label call that failed, or a tag Confluence cannot hold as a label
       * (FR-9.2). Neither is a reason to call the push blocked — the page *is*
       * published — and neither may be swallowed either, so they travel with the
       * success and are reported beside it.
       */
      readonly warnings: readonly AppError[];
    }
  | { readonly kind: 'conflict'; readonly conflict: PageConflict }
  | { readonly kind: 'blocked'; readonly blocked: PushBlocked };

export interface PushOptions {
  /** Skips round-trip verification only (FR-5.7). Never skips conflict detection. */
  readonly force?: boolean;
  /**
   * A remote version the user has explicitly accepted writing over (FR-6.4).
   *
   * Set by a "Keep Local" conflict resolution: the user has read the diff against
   * that version and said *publish mine anyway*. The remote is still checked — if
   * it has moved on *again* since the modal opened, that is a new conflict about a
   * diff they have not seen, and it is raised rather than overwritten.
   */
  readonly ontoVersion?: number;
}

function blocked(error: AppError): PushOutcome {
  return { kind: 'blocked', blocked: { error, local: null, roundTripped: null } };
}

/** The note body as the converter should see it: no frontmatter, no comments block. */
export function pushableBody(content: string): string {
  return stripManagedRegions(splitFrontmatter(content).body);
}

interface PreparedPush {
  readonly body: string;
  readonly storage: string;
  readonly options: ConversionOptions;
  /** Files to send before the body refers to them (FR-8.6). */
  readonly uploads: UploadPlan;
}

/**
 * Runs every local gate and returns the storage body that would be sent.
 *
 * Nothing here touches the network, so a page that cannot be pushed costs no
 * request at all — which is what makes "push all modified" safe to run on a
 * space where most pages are read-only.
 */
/** Gate 1 (FR-5.3): a page that could not be certified is never pushed. */
function certifiedOnly(state: PageState): PushOutcome | null {
  if (state.fidelity !== 'degraded') return null;

  return blocked(
    new AppError(
      'FIDELITY_DEGRADED',
      `"${state.title}" holds Confluence content this plugin could not reproduce exactly, ` +
        'so it is read-only. Edit it in Confluence instead.',
      { action: 'open-in-confluence' },
    ),
  );
}

/** Gate 2 (§6.4.3 rule 4): the preserved source behind every placeholder must exist. */
async function loadFragments(
  deps: PushDeps,
  state: PageState,
): Promise<Result<FragmentMap, PushOutcome>> {
  const stored = await deps.fragments.load(state.pageId);
  if (!stored.ok) return err(blocked(stored.error));

  if (stored.value === null) {
    return err(
      blocked(
        new AppError(
          'FRAGMENT_MISSING',
          `The preserved Confluence content for "${state.title}" is no longer cached. ` +
            'Pull this page again before pushing.',
          { action: 'repull-page' },
        ),
      ),
    );
  }
  return ok(stored.value.fragments);
}

/** Gate 3 (FR-5.2, §6.4.4 B): the edit has to survive `md -> storage -> md`. */
function verified(
  state: PageState,
  body: string,
  fragments: FragmentMap,
  conversion: ConversionOptions,
  options: PushOptions,
): Result<string, PushOutcome> {
  const result = verify(body, fragments, conversion);
  if (!result.ok) return err(blocked(result.error));
  if (result.value.verified || options.force === true) return ok(result.value.storage);

  return err({
    kind: 'blocked',
    blocked: {
      error: new AppError(
        'VERIFICATION_FAILED',
        `An edit in "${state.title}" cannot be written back to Confluence without changing ` +
          'it. The push was stopped so nothing is lost.',
        { action: 'show-diff' },
      ),
      local: body,
      roundTripped: result.value.roundTripped,
    },
  });
}

async function prepare(
  deps: PushDeps,
  target: PushTarget,
  options: PushOptions,
): Promise<Result<PreparedPush, PushOutcome>> {
  const { state } = target;

  const degraded = certifiedOnly(state);
  if (degraded !== null) return err(degraded);

  const content = await deps.vault.read(state.localPath);
  if (!content.ok) return err(blocked(content.error));
  const body = pushableBody(content.value);

  const fragments = await loadFragments(deps, state);
  if (!fragments.ok) return err(fragments.error);

  const inputs = { ...deps, spaceKey: target.spaceKey };

  // Pending uploads are resolved before conversion, not after: an embed pointing at
  // a file the page does not have converts to literal text, and verification would
  // then pass on a body that quietly lost a picture. Planning it here means the
  // gates run against the storage that will actually be sent (FR-8.6).
  const uploads = planUploads(
    deps,
    state.localPath,
    unresolvedEmbeds(body, fragments.value, conversionOptionsFor(inputs, state.attachments)),
    state.attachments,
  );
  if (!uploads.ok) return err(blocked(uploads.error));

  const conversion = conversionOptionsFor(inputs, uploads.value.attachments);
  const storage = verified(state, body, fragments.value, conversion, options);
  if (!storage.ok) return err(storage.error);

  return ok({ body, storage: storage.value, options: conversion, uploads: uploads.value });
}

/**
 * Checks the remote is still where the index left it (FR-6.1, FR-6.2).
 *
 * The body comes back with it and is kept: if this *is* a conflict, the modal
 * needs the remote content to diff, and asking twice would show the user a
 * version that had already moved again.
 */
async function checkRemote(
  deps: PushDeps,
  target: PushTarget,
  localBody: string,
  conversion: ConversionOptions,
  accepted: number | undefined,
): Promise<Result<ConfluencePage, PushOutcome>> {
  const remote = await deps.client.getPage(target.state.pageId);
  if (!remote.ok) return err(blocked(remote.error));

  // Either the remote is where the index left it, or it is at the version the
  // user read a diff against and chose to supersede. Anything else is a change
  // nobody here has seen.
  const expected = remote.value.version === target.state.remoteVersion;
  if (expected || remote.value.version === accepted) return ok(remote.value);

  return err({
    kind: 'conflict',
    conflict: buildConflict(target.state, localBody, remote.value, conversion),
  });
}

/** The material FR-6.3 requires the modal to show, assembled in one place. */
function buildConflict(
  state: PageState,
  localBody: string,
  remote: ConfluencePage,
  conversion: ConversionOptions,
): PageConflict {
  const asMarkdown = storageToMarkdown(remote.storage, conversion);

  return {
    pageId: state.pageId,
    title: remote.title,
    path: state.localPath,
    localBody,
    // A remote body that will not convert still has to be shown, or the conflict
    // cannot be resolved at all. The storage is the honest fallback.
    remoteBody: asMarkdown.ok ? asMarkdown.value.markdown : remote.storage,
    remoteStorage: remote.storage,
    remoteVersion: remote.version,
    remoteUpdatedAt: remote.updatedAt,
    remoteUpdatedBy: remote.updatedBy,
  };
}

/**
 * Describes an already-known conflict, without attempting a push (FR-6.2, FR-6.3).
 *
 * This is the path a *sync* takes: it has classified the page as conflicted from
 * versions and hashes alone, and now needs the two bodies to show a diff. Kept
 * separate from `pushPage` on purpose — running the verification gate first would
 * answer "this note cannot be represented" to a user who asked "what changed
 * remotely?", and they would never see the colleague's edit at all.
 */
export async function describeConflict(
  deps: PushDeps,
  target: PushTarget,
): Promise<Result<PageConflict, AppError>> {
  const content = await deps.vault.read(target.state.localPath);
  if (!content.ok) return content;

  const remote = await deps.client.getPage(target.state.pageId);
  if (!remote.ok) return remote;

  const conversion = conversionOptionsFor(
    { ...deps, spaceKey: target.spaceKey },
    target.state.attachments,
  );
  return ok(buildConflict(target.state, pushableBody(content.value), remote.value, conversion));
}

/**
 * Pushes one page (spec FR-5.1 to FR-5.7).
 *
 * Returns an outcome rather than a `Result`, because "conflict" is not a failure:
 * it is a question for the user, and it arrives carrying everything the modal
 * needs to ask it.
 */
export async function pushPage(
  deps: PushDeps,
  target: PushTarget,
  options: PushOptions = {},
): Promise<PushOutcome> {
  const prepared = await prepare(deps, target, options);
  if (!prepared.ok) return prepared.error;

  const { body, storage, options: conversion, uploads } = prepared.value;

  const checked = await checkRemote(deps, target, body, conversion, options.ontoVersion);
  if (!checked.ok) return checked.error;
  const remote = checked.value;

  // Only now, with every gate passed and the remote where it was expected: an
  // upload cannot be taken back (FR-8.7), so nothing is sent for a page that was
  // never going to be written.
  const attachments = await runUploads(deps, target.state.pageId, uploads);
  if (!attachments.ok) return blocked(attachments.error);

  const written = await writeBody(deps, target, storage, remote);
  if (!written.ok) return written.error;

  const labels = await applyLabels(deps, target.state);

  return record(deps, target, storage, written.value, {
    attachments: attachments.value,
    labels: labels.labels,
    warnings: labels.warnings,
  });
}

/** What the page now sits at, whether or not this push had a body to send. */
interface WrittenVersion {
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/**
 * Writes the body, unless the page already holds exactly it.
 *
 * Compared against the *remote's current* storage rather than the last-synced hash,
 * which matters for a "Keep Local" push: there the remote has moved, so a body
 * equal to what was pulled is still a body that has to be written over what a
 * colleague put there. Byte-identical storage, though, means a `PUT` would only add
 * a version to the page's history saying nothing — noise in a corporate wiki, and
 * the most common shape of push once tags are in play, where the user changed a tag
 * and nothing else.
 */
async function writeBody(
  deps: PushDeps,
  target: PushTarget,
  storage: string,
  remote: ConfluencePage,
): Promise<Result<WrittenVersion, PushOutcome>> {
  const { state } = target;

  if (storage === remote.storage) {
    deps.logger.debug(`"${state.title}" is already this body in Confluence; no version written.`);
    return ok({
      version: remote.version,
      updatedAt: remote.updatedAt,
      updatedBy: remote.updatedBy,
    });
  }

  const updated = await deps.client.updatePage({
    id: state.pageId,
    title: state.title,
    spaceKey: target.spaceKey,
    parentId: state.parentId,
    // Confluence accepts the write only at exactly one past the current version,
    // which is what makes a stale push a 409 instead of an overwrite (FR-5.4).
    version: remote.version + 1,
    storage,
  });
  return updated.ok ? ok(updated.value) : err(blocked(updated.error));
}

/**
 * Brings the note and the index up to date with what Confluence now holds.
 *
 * Only the identity block is rewritten: the body belongs to the user, and the
 * hash recorded afterwards is of the file as it actually ended up, so the next
 * sync sees an unmodified note rather than one that pushed itself.
 */
/** What the push changed besides the body, to fold into the page's record. */
interface PushedExtras {
  readonly attachments: Readonly<Record<string, AttachmentState>>;
  readonly labels: readonly string[];
  readonly warnings: readonly AppError[];
}

async function record(
  deps: PushDeps,
  target: PushTarget,
  storage: string,
  updated: WrittenVersion,
  extras: PushedExtras,
): Promise<PushOutcome> {
  const { state } = target;
  const identity: ConfluenceIdentity = {
    id: state.pageId,
    space: target.spaceKey,
    version: updated.version,
    parent: state.parentId,
    url: pageUrl(deps.baseUrl, state.pageId),
    updated: updated.updatedAt,
    updatedBy: updated.updatedBy,
    fidelity: state.fidelity,
  };

  const written = await deps.vault.updateIdentity(state.localPath, identity);
  if (!written.ok) return blocked(written.error);

  const storageHash = await sha256(storage);

  // The fragments are unchanged — they were re-injected verbatim — but they now
  // belong to a different storage body, and the sidecar records which one.
  const stored = await deps.fragments.load(state.pageId);
  if (stored.ok && stored.value !== null) {
    await deps.fragments.save(state.pageId, storageHash, stored.value.fragments);
  }

  deps.logger.debug(`Pushed ${state.title} as version ${String(updated.version)}.`);

  return {
    kind: 'pushed',
    state: {
      ...state,
      remoteVersion: updated.version,
      // The uploads are now attachments of the page like any other, so the next
      // pull recognises the files already in the vault instead of fetching them
      // back (FR-8.3), and the reverse conversion keeps resolving the embeds.
      attachments: extras.attachments,
      labels: extras.labels,
      localHash: await sha256(written.value),
      storageHash,
      lastSyncedAt: deps.now(),
    },
    warnings: extras.warnings,
  };
}
