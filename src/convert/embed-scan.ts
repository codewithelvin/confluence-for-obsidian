import { markdownToStorage } from './markdown-to-storage';
import type { ConversionOptions, FragmentMap } from './types';

/**
 * Which embeds in a note point at a file Confluence does not have (spec FR-8.6).
 *
 * Answered by running the conversion the push is about to run, with a recording
 * `attachmentFor`, rather than by scanning the text for `![[`. The difference is
 * not cosmetic: a `![[diagram.png]]` inside a code fence is literal text that the
 * converter correctly leaves alone, and a text scan would upload a file the page
 * never embeds. Only the paths conversion actually asks about can matter.
 *
 * The trial conversion's output is discarded — the real one runs later, against the
 * uploads this answer produced.
 */
export function unresolvedEmbeds(
  markdown: string,
  fragments: FragmentMap,
  options: ConversionOptions,
): ReadonlySet<string> {
  // Nearly every note has no embed at all, and this is on the push path for every
  // one of them. `![[` is the cheapest possible proof that there is nothing to find.
  if (!markdown.includes('![[')) return new Set();

  const unresolved = new Set<string>();
  const probe: ConversionOptions = {
    ...options,
    attachmentFor: (path) => {
      const known = options.attachmentFor?.(path) ?? null;
      if (known === null) unresolved.add(path);
      return known;
    },
  };

  // A conversion that fails tells us nothing about embeds, and it is about to fail
  // again in the push's own verification gate — which is where the user gets an
  // explanation. Answering "no pending uploads" here keeps that the message they see.
  const converted = markdownToStorage(markdown, fragments, probe);
  return converted.ok ? unresolved : new Set();
}
