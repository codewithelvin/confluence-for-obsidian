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

/** Every attachment file name the body refers to. */
export function referencedAttachments(storage: string): ReadonlySet<string> {
  const names = new Set<string>();

  for (const match of storage.matchAll(FILENAME)) {
    const filename = match[1];
    if (filename !== undefined) names.add(decodeAttribute(filename));
  }

  for (const match of storage.matchAll(DIAGRAM_NAME)) {
    const diagramName = match[1];
    if (diagramName === undefined) continue;
    for (const candidate of diagramCandidates(decodeAttribute(diagramName))) names.add(candidate);
  }
  return names;
}
