import type { ConfluenceClient } from '../api/confluence-client';
import { certify } from '../convert/round-trip-verifier';
import type { AppError } from '../util/errors';
import { ok, type Result } from '../util/result';

/**
 * Measures the converter against real pages.
 *
 * The golden corpus is hand-written from knowledge of storage format, so it
 * proves the converter is self-consistent but not that it matches what a
 * particular Confluence instance actually emits. This probe closes that gap:
 * it converts real pages, reports how many could be pushed safely, and records
 * the specific format details the converter had to guess at.
 *
 * Read-only. It fetches page bodies and writes nothing back.
 */

export type Outcome = 'certified' | 'degraded' | 'unreadable';

export interface PageFidelity {
  readonly id: string;
  readonly title: string;
  readonly outcome: Outcome;
  /** Why it is not certified, or `null`. */
  readonly detail: string | null;
  /** Kept only for pages that failed, so the cause can be inspected. */
  readonly storage: string | null;
}

/**
 * Format details the converter assumed. Each corresponds to a decision that
 * would silently make pages read-only if the assumption were wrong.
 */
export interface FormatObservations {
  /** Cells written as `<th><p>x</p></th>`. The converter currently writes bare cells. */
  readonly tableCellsWithParagraphs: number;
  /** Cells written as `<th>x</th>`, matching what the converter writes. */
  readonly tableCellsBare: number;
  readonly withMacroId: number;
  readonly withLocalId: number;
  readonly withSchemaVersion: number;
  readonly withInlineComments: number;
  readonly withPageLinksMissingSpaceKey: number;
}

export interface FidelityReport {
  readonly spaceKey: string;
  readonly sampled: number;
  readonly certified: number;
  readonly degraded: number;
  readonly unreadable: number;
  readonly observations: FormatObservations;
  readonly pages: readonly PageFidelity[];
}

const PATTERNS = {
  tableCellsWithParagraphs: /<t[hd][^>]*>\s*<p[\s>]/i,
  tableCellsBare: /<t[hd][^>]*>\s*(?!<p[\s>])[^<\s]/i,
  withMacroId: /\bac:macro-id\s*=/i,
  withLocalId: /\bac:local-id\s*=/i,
  withSchemaVersion: /\bac:schema-version\s*=/i,
  withInlineComments: /<ac:inline-comment-marker[\s>]/i,
  withPageLinksMissingSpaceKey: /<ri:page(?![^>]*ri:space-key)[^>]*>/i,
} as const;

/** Which format traits a single storage body exhibits. Pure, so it is testable. */
export function observeFormat(storage: string): ReadonlySet<keyof FormatObservations> {
  const found = new Set<keyof FormatObservations>();
  for (const [trait, pattern] of Object.entries(PATTERNS)) {
    if (pattern.test(storage)) found.add(trait as keyof FormatObservations);
  }
  return found;
}

export interface ProbeOptions {
  readonly baseUrl: string;
  readonly limit: number;
  onProgress?(done: number, total: number): void;
  /** Returns true to stop early. */
  isCancelled?(): boolean;
}

function emptyObservations(): Record<keyof FormatObservations, number> {
  return {
    tableCellsWithParagraphs: 0,
    tableCellsBare: 0,
    withMacroId: 0,
    withLocalId: 0,
    withSchemaVersion: 0,
    withInlineComments: 0,
    withPageLinksMissingSpaceKey: 0,
  };
}

/** Longest storage excerpt kept for a failing page. */
const MAX_KEPT_STORAGE = 4000;

export async function probeSpaceFidelity(
  client: ConfluenceClient,
  spaceKey: string,
  options: ProbeOptions,
): Promise<Result<FidelityReport, AppError>> {
  const listed = await client.listPages(spaceKey, options.limit);
  if (!listed.ok) return listed;

  const observations = emptyObservations();
  const pages: PageFidelity[] = [];

  for (const [index, summary] of listed.value.entries()) {
    if (options.isCancelled?.() === true) break;
    options.onProgress?.(index, listed.value.length);

    pages.push(await probeOnePage(client, summary.id, summary.title, options, observations));
  }

  return ok({
    spaceKey,
    sampled: pages.length,
    certified: pages.filter((page) => page.outcome === 'certified').length,
    degraded: pages.filter((page) => page.outcome === 'degraded').length,
    unreadable: pages.filter((page) => page.outcome === 'unreadable').length,
    observations,
    pages,
  });
}

async function probeOnePage(
  client: ConfluenceClient,
  id: string,
  title: string,
  options: ProbeOptions,
  observations: Record<keyof FormatObservations, number>,
): Promise<PageFidelity> {
  const fetched = await client.getPage(id);
  if (!fetched.ok) {
    return { id, title, outcome: 'unreadable', detail: fetched.error.userMessage, storage: null };
  }

  const page = fetched.value;
  for (const trait of observeFormat(page.storage)) observations[trait] += 1;

  const result = certify(page.storage, {
    baseUrl: options.baseUrl,
    spaceKey: page.spaceKey.length > 0 ? page.spaceKey : spaceKeyOf(page.storage),
  });

  if (!result.ok) {
    return {
      id,
      title,
      outcome: 'unreadable',
      detail: result.error.userMessage,
      storage: page.storage.slice(0, MAX_KEPT_STORAGE),
    };
  }

  return {
    id,
    title,
    outcome: result.value.certified ? 'certified' : 'degraded',
    detail: result.value.detail,
    storage: result.value.certified ? null : page.storage.slice(0, MAX_KEPT_STORAGE),
  };
}

/** Fallback when the API omitted the space; only affects link normalisation. */
function spaceKeyOf(storage: string): string {
  return /ri:space-key="([^"]+)"/.exec(storage)?.[1] ?? '';
}
