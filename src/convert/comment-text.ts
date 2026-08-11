import { childrenOf, parseStorage, tagOf } from './storage-parser';

/**
 * A comment's body as readable plain text (spec FR-9.3, §6.7).
 *
 * The comments region is **read-only** and is never pushed (FR-5.8), so a comment
 * needs none of the preserve-and-reinflate machinery the page body needs: nothing
 * here has to survive a round trip. That is what makes plain text the right
 * answer rather than a second conversion path — a comment rendered through the
 * full converter would mint placeholders and fragments for content no push will
 * ever send back, and every one of them would be noise in the reader's note.
 *
 * The cost is that a picture or a macro inside a comment does not appear. A
 * comment is prose in all but the rarest case, and losing the prose to keep an
 * embed nobody can click would be the worse trade.
 */

/** Elements that end the line they are on. Everything else is inline. */
const BREAKS_LINE = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'tr',
  'table',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

/** Collects text into lines, breaking at every block boundary. */
class LineBuilder {
  private readonly lines: string[] = [];
  private current = '';

  append(text: string): void {
    this.current += text;
  }

  break(): void {
    const line = this.current.replace(/\s+/g, ' ').trim();
    if (line.length > 0) this.lines.push(line);
    this.current = '';
  }

  finish(): readonly string[] {
    this.break();
    return this.lines;
  }
}

function walk(node: Node, lines: LineBuilder): void {
  if (node.nodeType === Node.TEXT_NODE) {
    lines.append(node.nodeValue ?? '');
    return;
  }
  // A comment node in a *comment body* is markup, not content: `<!--cf-…-->`
  // carriers only exist in a page body, and either way there is nothing here to
  // preserve for a push.
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const breaks = BREAKS_LINE.has(tagOf(node as Element));
  if (breaks) lines.break();
  for (const child of childrenOf(node)) walk(child, lines);
  if (breaks) lines.break();
}

/**
 * Last resort for a body the XML parser refuses.
 *
 * Storage format from Confluence parses; a comment stored by an old plugin or a
 * half-migrated instance may not. Stripping tags shows the reader the remark,
 * which is the whole point of the region — refusing would hide a colleague's
 * words behind a parser error they cannot act on.
 */
function stripTags(storage: string): readonly string[] {
  return storage
    .replace(/<[^>]*>/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** The comment body as lines of plain text, in document order. */
export function commentText(storage: string): readonly string[] {
  const parsed = parseStorage(storage);
  if (!parsed.ok) return stripTags(storage);

  const lines = new LineBuilder();
  for (const child of childrenOf(parsed.value)) walk(child, lines);
  return lines.finish();
}
