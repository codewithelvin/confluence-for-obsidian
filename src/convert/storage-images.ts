import type { PhrasingContent } from 'mdast';
import { makeInlinePlaceholder, preserveBeside } from './placeholder-factory';
import { carriedImage } from './placeholder-registry';
import { firstElement, riAttr, tagOf } from './storage-parser';
import type { ConversionContext } from './types';
import { embedSize, formatEmbed, isLinkable } from './wikilink';

/**
 * Pictures, storage format to Markdown (spec FR-8.2).
 *
 * Its own module because there are three quite different answers here and the rules
 * for choosing between them are the fiddliest part of inline conversion: an Obsidian
 * embed for an attachment on disk, a plain Markdown image for one hosted elsewhere,
 * and a placeholder for anything carrying markup neither form can hold.
 */

/**
 * The size to *show* the picture at.
 *
 * A lone `ac:height` is displayed as a width. Obsidian's embed syntax sizes by
 * width, so the alternative is no size at all — and an icon Confluence drew at 16
 * pixels then fills the line at its natural size, which on the first live page of
 * space TT happened to five of seventeen pictures. Square icons are unaffected and
 * anything else is far closer than full size; the exact markup is carried alongside,
 * so a push still hands Confluence back the height it gave us.
 */
function displaySize(width: string | null, height: string | null): string | null {
  return width === null ? height : embedSize(width, height);
}

/**
 * Characters that would end a Markdown image before its URL does.
 *
 * A URL holding one is left as a placeholder rather than escaped: the embed is
 * written into an `html` node and read back by the Markdown parser on the way out,
 * so anything the parser would read differently has to stay out of it.
 */
const UNSAFE_IN_URL = /[\s()[\]<>]/;

/**
 * An image hosted somewhere else — `<ri:url>` rather than `<ri:attachment>`.
 *
 * Markdown expresses this exactly: `![](https://…)`, which Obsidian renders, and
 * which needs no download because there is no attachment to download. Left as a
 * placeholder it was one of the biggest readability losses left in the mirror — the
 * first live page of space TT had **fourteen** of them, every Jira issue-type icon
 * in a page whose whole subject is issue types, each one a grey pill.
 *
 * The size rides in the alt text, which is Obsidian's own convention for sizing an
 * external image (`![|16x16](…)`). Only `http` and `https` are written out: a
 * `javascript:` or `data:` URL from a page body is untrusted input (§7.4), and this
 * is the one place a Confluence attribute would become a link the reader can follow.
 */
function convertExternalImage(
  element: Element,
  resource: Element,
  ctx: ConversionContext,
): PhrasingContent {
  const url = riAttr(resource, 'value');
  const width = element.getAttribute('ac:width');
  const height = element.getAttribute('ac:height');
  const sizing = (width === null ? 0 : 1) + (height === null ? 0 : 1);

  const writable =
    url !== null && /^https?:\/\//i.test(url) && !UNSAFE_IN_URL.test(url) && url.length > 0;
  if (!writable) {
    return makeInlinePlaceholder(ctx.placeholders, element, {
      type: 'image',
      label: 'image: linked from another site',
    });
  }

  // Reproducible when the element carries nothing but the sizing Markdown can hold,
  // and the resource nothing but its URL. Anything else — a thumbnail, a border, a
  // lone height — stays a placeholder.
  //
  // No `carriedImage` here, deliberately, unlike the attachment path above. The
  // carrier is found by scanning a *text* run for the embed it follows, and a
  // Markdown image is a node of its own rather than text, so the marker would be
  // read back with nothing attached to it and the preserved attributes would be
  // dropped on the way out. That is a fidelity loss, and it is exactly what the
  // `image-placeholder-unknown-attachment` fixture caught.
  const reproducible =
    resource.attributes.length === 1 &&
    element.attributes.length === sizing &&
    (width !== null || height === null);

  if (!reproducible) {
    return makeInlinePlaceholder(ctx.placeholders, element, {
      type: 'image',
      label: 'image: linked from another site',
    });
  }

  const size = embedSize(width, height);
  return { type: 'html', value: `![${size === null ? '' : `|${size}`}](${url})` };
}

/**
 * An attached image as an Obsidian embed (spec FR-8.2).
 *
 * An embed reproduces an `<ac:image>` exactly when the image carries nothing but
 * the sizing Obsidian can express and wraps an `<ri:attachment>` carrying nothing
 * but its file name. That is most of them, and they convert cleanly.
 *
 * The rest — `ac:thumbnail`, a border, a caption, a lone height — still *show*,
 * with their source carried alongside in the fragment cache and marked by a
 * comment the reader never sees (`carriedImage`). Obsidian draws the picture, and
 * push hands Confluence back the markup it gave us, down to the border. 1 088
 * pictures in the mirror are this shape, sequence diagrams and BPMN exports among
 * them, and every one of them used to be a label.
 *
 * An attachment that is *not* on disk is the one case left as a placeholder: a
 * broken embed is worse than an honest label saying what is preserved. Almost all
 * of those were skipped for size — see the attachment size limit (FR-8.4).
 */
export function convertImage(element: Element, ctx: ConversionContext): PhrasingContent {
  const resource = firstElement(element);
  if (resource !== null && tagOf(resource) === 'ri:url') {
    return convertExternalImage(element, resource, ctx);
  }

  const filename = resource === null ? null : riAttr(resource, 'filename');
  const width = element.getAttribute('ac:width');
  const height = element.getAttribute('ac:height');
  const sizing = (width === null ? 0 : 1) + (height === null ? 0 : 1);

  const reproducible =
    resource !== null &&
    tagOf(resource) === 'ri:attachment' &&
    resource.attributes.length === 1 &&
    element.attributes.length === sizing &&
    // A height with no width alongside it is shown as a width, which is an
    // approximation, so the source is carried rather than claimed reproducible.
    (width !== null || height === null);

  const path = filename === null ? null : (ctx.resolveAttachment?.(filename) ?? null);
  const embeddable = filename !== null && path !== null && isLinkable(path);

  if (embeddable) {
    const embed = formatEmbed(path, displaySize(width, height));
    if (reproducible) return { type: 'html', value: embed };

    const carried = preserveBeside(ctx.placeholders, element, {
      type: 'image',
      label: `image: ${filename}`,
    });
    return { type: 'html', value: `${embed}${carriedImage(carried)}` };
  }

  return makeInlinePlaceholder(ctx.placeholders, element, {
    type: 'image',
    label: `image: ${filename ?? 'embedded'}`,
  });
}
