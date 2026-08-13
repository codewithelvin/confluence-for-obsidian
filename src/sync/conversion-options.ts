import type { ConversionOptions } from '../convert/types';
import type { PageTarget } from '../convert/types';
import type { AttachmentState } from './sync-state';

/**
 * The one place a `ConversionOptions` is assembled (spec §6.4).
 *
 * Both directions of every resolver have to come from the same table or they
 * disagree, and a disagreement does not fail loudly: it makes a page read-only,
 * or writes an embed for a file that is not there. Pull and push therefore build
 * their options here rather than each listing the fields themselves.
 */

/** What the caller knows that does not depend on the page's attachments. */
export interface ConversionInputs {
  readonly baseUrl: string;
  readonly spaceKey: string;
  readonly strictMarkup: boolean;
  /** Wikilink resolution, in both directions (spec FR-4.7). */
  readonly resolveTarget: (target: PageTarget) => string | null;
  readonly resolveVaultPath: (path: string) => PageTarget | null;
  /** The same table keyed by Confluence's page id, for a pasted URL (spec FR-4.23). */
  readonly resolvePageId: (pageId: string) => string | null;
}

/**
 * Options for one page, given the attachments already recorded for it.
 *
 * `attachmentFor` is the inverse index of `resolveAttachment`, built from the
 * same record: a path the forward pass writes is a path the reverse pass reads
 * (FR-8.2).
 */
export function conversionOptionsFor(
  inputs: ConversionInputs,
  attachments: Readonly<Record<string, AttachmentState>>,
): ConversionOptions {
  const byPath = new Map<string, string>(
    Object.entries(attachments).map(([filename, state]) => [state.localPath, filename]),
  );

  return {
    baseUrl: inputs.baseUrl,
    spaceKey: inputs.spaceKey,
    strictMarkup: inputs.strictMarkup,
    resolveTarget: inputs.resolveTarget,
    resolveVaultPath: inputs.resolveVaultPath,
    resolvePageId: inputs.resolvePageId,
    resolveAttachment: (filename) => attachments[filename]?.localPath ?? null,
    attachmentFor: (path) => byPath.get(path) ?? null,
  };
}
