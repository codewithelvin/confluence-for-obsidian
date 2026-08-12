import type { ConfluencePage } from '../api/api-types';
import type { ConfluenceGateway } from '../api/confluence-client';
import { certify } from '../convert/round-trip-verifier';
import type { ConversionOptions, PageTarget } from '../convert/types';
import { AppError } from '../util/errors';
import { sha256 } from '../util/hash';
import { err, ok, type Result } from '../util/result';
import type { Logger } from '../util/logger';
import { pageUrl, type ConfluenceIdentity } from '../vault/frontmatter';
import { parentPath, type VaultGateway } from '../vault/vault-gateway';
import type { AttachmentOutcome, SkippedAttachment } from './attachment-executor';
import type { CommentOutcome } from './comments-executor';
import { conversionOptionsFor } from './conversion-options';
import type { FragmentStore } from './fragment-store';
import { withManagedRegions } from './managed-regions';
import type { LocalPage, PullItem, RelocateItem } from './pull-planner';
import type { AttachmentState, PageState } from './sync-state';
import type { SyncFailure } from './sync-types';

/**
 * Applying a pull plan to the vault (spec §6.6.2 step 6).
 *
 * One page's failure never aborts the sync (FR-3.9): each is caught, recorded
 * and reported at the end. The engine above decides *what* to do; this decides
 * nothing and only carries it out.
 */

/** Bodies fetched at once. The client caps in-flight requests at four (§6.2.2). */
const FETCH_BATCH = 4;

export interface ExecutorDeps {
  readonly client: ConfluenceGateway;
  readonly vault: VaultGateway;
  readonly fragments: FragmentStore;
  readonly logger: Logger;
  readonly baseUrl: string;
  /** Byte-faithful conversion for this connection (spec FR-4.12). */
  readonly strictMarkup: boolean;
  /** Wikilink resolution, in both directions (spec FR-4.7). */
  readonly resolveTarget: (target: PageTarget) => string | null;
  readonly resolveVaultPath: (path: string) => PageTarget | null;
  /**
   * Downloads the page's attachments and reports what is now on disk (FR-8.1).
   *
   * Injected rather than called directly so the executor stays a pure applier of
   * a plan: it decides *when* attachments are needed — before conversion — and
   * nothing about which ones or how.
   */
  readonly attachments: (item: PullItem, storage: string) => Promise<AttachmentOutcome>;
  /**
   * Fetches the page's comments and renders the managed region (FR-9.3).
   *
   * Injected for the same reason attachments are, and consulted *after* the body is
   * converted: the region is appended to the converter's output and is not part of
   * what gets converted.
   */
  readonly comments: (item: PullItem) => Promise<CommentOutcome>;
  readonly now: () => string;
}

export interface PullOutcome {
  readonly states: readonly PageState[];
  readonly degraded: readonly LocalPage[];
  readonly failures: readonly SyncFailure[];
  readonly attachmentsDownloaded: number;
  readonly skippedAttachments: readonly SkippedAttachment[];
  /** Comments written into managed regions this pull (FR-9.3). */
  readonly commentsPulled: number;
  /** Notes that now carry a comments region, for the report. */
  readonly commentRegions: number;
}

/** Collected as pages are written, then reported together (FR-3.9). */
interface PullAccumulator {
  readonly states: PageState[];
  readonly degraded: LocalPage[];
  readonly failures: SyncFailure[];
  readonly skippedAttachments: SkippedAttachment[];
  attachmentsDownloaded: number;
  commentsPulled: number;
  commentRegions: number;
}

function emptyAccumulator(): PullAccumulator {
  return {
    states: [],
    degraded: [],
    failures: [],
    skippedAttachments: [],
    attachmentsDownloaded: 0,
    commentsPulled: 0,
    commentRegions: 0,
  };
}

function failure(pageId: string, title: string, error: AppError): SyncFailure {
  return { pageId, title, error };
}

/**
 * Moves a page to where the new tree puts it.
 *
 * A move whose source has already gone and whose destination already exists is
 * treated as done rather than as an error: moving a folder note carries its
 * children with it, so by the time a child's own move comes up it is usually
 * already in place.
 */
export async function relocate(deps: ExecutorDeps, item: RelocateItem): Promise<AppError | null> {
  for (const move of item.moves) {
    if (!deps.vault.exists(move.from) && deps.vault.exists(move.to)) continue;

    const result = await deps.vault.move(move.from, move.to);
    if (!result.ok) return result.error;

    await deps.vault.removeEmptyFolder(parentPath(move.from));
  }
  return null;
}

function identityFor(
  deps: ExecutorDeps,
  item: PullItem,
  fidelity: 'certified' | 'degraded',
): ConfluenceIdentity {
  return {
    id: item.page.id,
    space: item.page.spaceKey,
    version: item.page.version,
    parent: item.page.parentId,
    url: pageUrl(deps.baseUrl, item.page.id),
    updated: item.page.updatedAt,
    updatedBy: item.page.updatedBy,
    fidelity,
  };
}

/**
 * Everything the converter needs for one page, including how to resolve the
 * attachments just downloaded for it (FR-8.2).
 *
 * Assembled by `conversionOptionsFor`, which the push path uses too — the two
 * must agree exactly, or a page the pull certified would fail verification on
 * the way back out.
 */
function conversionOptions(
  deps: ExecutorDeps,
  item: PullItem,
  attachments: Readonly<Record<string, AttachmentState>>,
): ConversionOptions {
  return conversionOptionsFor({ ...deps, spaceKey: item.page.spaceKey }, attachments);
}

/**
 * Downloads the page's attachments before its body is converted.
 *
 * Before, not after: the converter can only write an embed for a file already on
 * disk (FR-8.2), and an embed pointing at nothing is a broken image.
 */
async function downloadAttachments(
  deps: ExecutorDeps,
  item: PullItem,
  storage: string,
  outcome: PullAccumulator,
): Promise<Readonly<Record<string, AttachmentState>>> {
  const attachments = await deps.attachments(item, storage);

  outcome.attachmentsDownloaded += attachments.downloaded;
  outcome.skippedAttachments.push(...attachments.skipped);
  outcome.failures.push(...attachments.failures);
  return attachments.attachments;
}

/**
 * Fetches the comments region, which is appended to the converted body.
 *
 * After conversion and outside certification: the region is not the page, and a
 * colleague's remark must never be able to make a page read-only.
 */
async function fetchComments(
  deps: ExecutorDeps,
  item: PullItem,
  outcome: PullAccumulator,
): Promise<string> {
  const comments = await deps.comments(item);

  outcome.commentsPulled += comments.comments;
  if (comments.region.length > 0) outcome.commentRegions += 1;
  outcome.failures.push(...comments.failures);
  return comments.region;
}

/**
 * Converts and writes one page.
 *
 * Certification never blocks the write (FR-4.4): a page that cannot round-trip
 * is still written and still readable, and is marked `degraded` so push stays
 * disabled for it.
 */
async function writePage(
  deps: ExecutorDeps,
  item: PullItem,
  page: ConfluencePage,
  outcome: PullAccumulator,
): Promise<AppError | null> {
  const { storage } = page;

  const byFilename = await downloadAttachments(deps, item, storage, outcome);
  const converted = certify(storage, conversionOptions(deps, item, byFilename));
  if (!converted.ok) return converted.error;

  const region = await fetchComments(deps, item, outcome);
  const fidelity = converted.value.certified ? 'certified' : 'degraded';
  const written = await deps.vault.writeNote({
    path: item.path,
    body: withManagedRegions(converted.value.markdown, region),
    identity: identityFor(deps, item, fidelity),
    alias: item.alias,
    previousAlias: item.previousAlias,
    tags: page.labels,
    previousTags: item.previousLabels,
  });
  if (!written.ok) return written.error;

  const storageHash = await sha256(storage);
  const saved = await deps.fragments.save(item.page.id, storageHash, converted.value.fragments);
  if (!saved.ok) return saved.error;

  if (fidelity === 'degraded') {
    deps.logger.debug(`Degraded: ${item.page.title} — ${converted.value.detail ?? 'unknown'}`);
    outcome.degraded.push({ pageId: item.page.id, title: item.page.title, path: item.path });
  }

  outcome.states.push({
    pageId: item.page.id,
    title: item.page.title,
    parentId: item.page.parentId,
    remoteVersion: item.page.version,
    localPath: item.path,
    isFolderNote: item.isFolderNote,
    alias: item.alias,
    attachments: byFilename,
    // What the page's labels are *and* what the plugin now owns in `tags`: the two
    // are the same set, and recording it is what lets the next pull remove a label
    // that has gone without touching a tag the user added (FR-9.1).
    labels: page.labels,
    localHash: await sha256(written.value),
    storageHash,
    fidelity,
    lastSyncedAt: deps.now(),
  });
  return null;
}

export interface PullProgress {
  readonly onPage?: (done: number, total: number) => void;
  readonly isCancelled?: () => boolean;
}

/**
 * Fetches and writes every page in the plan.
 *
 * Bodies are fetched a batch at a time and written one at a time: fetching is
 * network-bound and parallelises well, while writing touches the vault and the
 * index, where ordering matters.
 */
export async function pullPages(
  deps: ExecutorDeps,
  items: readonly PullItem[],
  progress: PullProgress = {},
): Promise<PullOutcome> {
  const outcome = emptyAccumulator();
  let done = 0;

  for (let index = 0; index < items.length; index += FETCH_BATCH) {
    if (progress.isCancelled?.() === true) break;

    const batch = items.slice(index, index + FETCH_BATCH);
    const fetched = await Promise.all(batch.map((item) => deps.client.getPage(item.page.id)));

    for (const [offset, result] of fetched.entries()) {
      const item = batch[offset];
      if (item === undefined) continue;

      const error = result.ok ? await writePage(deps, item, result.value, outcome) : result.error;
      if (error !== null) outcome.failures.push(failure(item.page.id, item.page.title, error));

      done += 1;
      progress.onPage?.(done, items.length);
    }
  }

  return outcome;
}

/** Where a single-page pull writes, as the index already records it. */
export interface SinglePageTarget {
  readonly path: string;
  readonly isFolderNote: boolean;
  readonly alias: string | null;
  /** Labels the note currently holds on the plugin's behalf (FR-9.1). */
  readonly labels: readonly string[];
}

/**
 * Re-pulls one page on demand (spec FR-3.8).
 *
 * The page reference comes from the fetch itself rather than from the index, so
 * the command works on a note whose index entry was lost — which is exactly
 * when a user reaches for it.
 */
export async function pullSinglePage(
  deps: ExecutorDeps,
  pageId: string,
  target: SinglePageTarget,
): Promise<Result<PageState, AppError>> {
  const fetched = await deps.client.getPage(pageId);
  if (!fetched.ok) return fetched;

  const outcome = emptyAccumulator();
  const error = await writePage(
    deps,
    {
      page: fetched.value,
      path: target.path,
      isFolderNote: target.isFolderNote,
      isNew: false,
      // Unchanged on purpose: a single-page pull refreshes a body in place and
      // never recomputes the path, so the name — and therefore the alias that
      // stands in for the title — is not its business either.
      alias: target.alias,
      previousAlias: target.alias,
      previousLabels: target.labels,
    },
    fetched.value,
    outcome,
  );
  if (error !== null) return err(error);

  const state = outcome.states[0];
  return state === undefined
    ? err(new AppError('UNKNOWN', `Nothing was written for page ${pageId}.`))
    : ok(state);
}

/** What a deletion pass managed to remove, and what stopped it (FR-3.5, FR-3.9). */
export interface DeleteOutcome {
  /**
   * Notes that are genuinely gone.
   *
   * Kept apart from what was *asked for*, because the caller drops the index entry of
   * everything in here: a page whose file the vault refused to trash must keep its
   * entry, or the note is left on disk with an identity nothing tracks.
   */
  readonly deleted: readonly LocalPage[];
  readonly failures: readonly SyncFailure[];
}

/** Trashes the notes of pages that no longer exist remotely (FR-3.5). */
export async function deletePages(
  deps: ExecutorDeps,
  pages: readonly LocalPage[],
): Promise<DeleteOutcome> {
  const deleted: LocalPage[] = [];
  const failures: SyncFailure[] = [];

  for (const page of pages) {
    const result = await deps.vault.trash(page.path);
    if (!result.ok) {
      failures.push(failure(page.pageId, page.title, result.error));
      continue;
    }
    await deps.vault.removeEmptyFolder(parentPath(page.path));
    await deps.fragments.remove(page.pageId);
    deleted.push(page);
  }
  return { deleted, failures };
}
