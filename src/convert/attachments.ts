import { diagramCandidates } from './storage-drawio';

/**
 * Which attachments a page body refers to (spec FR-8.5).
 *
 * Read straight off the raw storage rather than the parsed tree, because the
 * answer is needed *before* conversion: the converter can only write an embed for
 * a file that has already been downloaded, and the downloader only wants the
 * files the page actually uses.
 *
 * Deliberately inclusive. A name matched here that turns out not to be an
 * attachment costs one wasted request; a name missed leaves the reader an opaque
 * placeholder where a picture should be.
 */

/**
 * `ri:filename` is the attribute Confluence writes for every attachment
 * reference — an image, a `view-file` macro, a link to a document. One pattern
 * covers all of them.
 */
const FILENAME = /ri:filename="([^"]+)"/g;

/** Entity forms that can appear inside an attribute value. */
const ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);

function decodeAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES.get(entity) ?? entity);
}

/**
 * A diagram macro names its diagram in a parameter, not in `ri:filename`
 * (spec FR-8.8, §6.4.8) — so the one pattern above cannot see it, and a page whose
 * only attachment is a diagram would never even be listed.
 */
const DIAGRAM_NAME = /<ac:parameter ac:name="diagramName">([^<]*)<\/ac:parameter>/g;

/**
 * What a page body says about the attachments it uses.
 *
 * The two sets are kept apart because a *miss* means opposite things. A name the
 * body states outright and the page does not have is worth telling the user about:
 * the reference has outlived the file, and that is why FR-4.17 leaves a widget where
 * a picture belongs. A diagram candidate that misses is the normal case — two of the
 * three rungs always miss — and reporting those would bury the real news.
 */
export interface ReferencedAttachments {
  /** Every name worth asking the page's listing for. */
  readonly all: ReadonlySet<string>;
  /** Names the body states outright, through an `ri:filename`. */
  readonly named: ReadonlySet<string>;
}

/** Every attachment file name the body refers to. */
export function referencedAttachments(storage: string): ReferencedAttachments {
  const named = new Set<string>();

  for (const match of storage.matchAll(FILENAME)) {
    const filename = match[1];
    if (filename !== undefined) named.add(decodeAttribute(filename));
  }

  const all = new Set(named);
  for (const match of storage.matchAll(DIAGRAM_NAME)) {
    const diagramName = match[1];
    if (diagramName === undefined) continue;
    for (const candidate of diagramCandidates(decodeAttribute(diagramName))) all.add(candidate);
  }
  return { all, named };
}
