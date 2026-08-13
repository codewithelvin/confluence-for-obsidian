import type { Fragment, FragmentKind, FragmentMap } from './types';

/**
 * The placeholder contract (spec §6.4.3).
 *
 * Constructs Markdown cannot express become opaque placeholders, and their
 * storage-format source is preserved verbatim for re-injection on push. This is
 * what makes push safe: the plugin never reconstructs something it did not
 * fully understand.
 *
 * Ids are assigned in document order so that converting unchanged content twice
 * yields identical placeholders — required for the idempotence guarantee.
 */

export const BLOCK_FENCE_LANGUAGE = 'confluence-block';

/**
 * Separator inserted between two adjacent code spans.
 *
 * Markdown cannot express them adjacently: `` `a``b` `` re-parses as a single
 * span containing ``a``b``, which silently merges two placeholders into one
 * piece of literal text. Confluence pages hit this constantly — an inline image
 * immediately followed by a styled span is two placeholders side by side.
 *
 * The separator is removed again on the way back, so nothing reaches Confluence.
 */
export const CODE_SEPARATOR = '​';

const ID_PREFIX = 'cfb-';
const ID_DIGITS = 4;

/** Inline form: `` `{cf:cfb-0001}` `` — inline code survives Markdown round-tripping unchanged. */
const INLINE_PATTERN = /^\{cf:(cfb-\d+)\}$/;

export interface FragmentInput {
  readonly kind: FragmentKind;
  readonly xhtml: string;
  readonly type: string;
  readonly name?: string | null;
  readonly label: string;
}

function idFor(counter: number): string {
  return `${ID_PREFIX}${String(counter).padStart(ID_DIGITS, '0')}`;
}

export class PlaceholderRegistry {
  private readonly fragments = new Map<string, Fragment>();
  private counter = 0;

  add(input: FragmentInput): Fragment {
    this.counter += 1;
    const id = idFor(this.counter);

    const fragment: Fragment = {
      id,
      kind: input.kind,
      xhtml: input.xhtml,
      type: input.type,
      name: input.name ?? null,
      label: input.label,
    };

    this.fragments.set(id, fragment);
    return fragment;
  }

  snapshot(): FragmentMap {
    return new Map(this.fragments);
  }

  /**
   * Where the registry stands, for a caller that has to allocate before it can know
   * whether it will keep the result.
   */
  mark(): number {
    return this.counter;
  }

  /**
   * Discards everything added since `mark`, counter included.
   *
   * `tableAsHtml` is why this exists: it has to replace a table's images *before* it
   * can ask whether anything namespaced is left, and two of its gates still refuse
   * afterwards. Without a rollback those replacements stayed in the sidecar
   * unreferenced by any note, and every later placeholder on the page moved up a
   * number — deterministic, but so is being wrong the same way every time.
   *
   * The counter goes back too, which is what keeps §6.4.3's promise: ids read down
   * the page in document order, with no gap where a refused projection used to be.
   */
  rollbackTo(mark: number): void {
    for (let counter = mark + 1; counter <= this.counter; counter += 1) {
      this.fragments.delete(idFor(counter));
    }
    this.counter = mark;
  }

  get size(): number {
    return this.fragments.size;
  }
}

/** The text inside a `{cf:…}` inline placeholder. */
export function inlinePlaceholderValue(fragment: Fragment): string {
  return `{cf:${fragment.id}}`;
}

/** Extracts a fragment id from inline-code content, or `null` if it is ordinary code. */
export function readInlinePlaceholderId(inlineCodeValue: string): string | null {
  return INLINE_PATTERN.exec(inlineCodeValue.trim())?.[1] ?? null;
}

/** One inline sentinel found in Markdown source, backticks included. */
export interface InlinePlaceholderMatch {
  readonly id: string;
  /** Offset of the opening backtick. */
  readonly from: number;
  /** Offset just past the closing backtick. */
  readonly to: number;
}

/** The sentinel as it appears in the *note*: a whole inline-code span, backticks and all. */
const SOURCE_PATTERN = /`\{cf:cfb-\d+\}`/g;
const SOURCE_OPENING = '`{cf:'.length;
const SOURCE_CLOSING = '}`'.length;

/**
 * Every inline sentinel in a stretch of Markdown source (spec FR-4.5, D16).
 *
 * The Reading View renderer works on rendered HTML and asks `readInlinePlaceholderId`
 * whether a `<code>` element is a sentinel. Live Preview has no HTML to inspect — it
 * decorates the *source text* — so it needs the same grammar expressed over a string.
 * D16 requires the two renderers to stay in step, which is why both forms live here
 * rather than one of them living beside its renderer.
 */
export function findInlinePlaceholders(markdown: string): readonly InlinePlaceholderMatch[] {
  // A fresh regex per call: `lastIndex` on a shared global pattern would make the
  // result depend on who scanned last.
  const pattern = new RegExp(SOURCE_PATTERN.source, 'g');
  const found: InlinePlaceholderMatch[] = [];

  let match = pattern.exec(markdown);
  while (match !== null) {
    found.push({
      id: match[0].slice(SOURCE_OPENING, -SOURCE_CLOSING),
      from: match.index,
      to: match.index + match[0].length,
    });
    match = pattern.exec(markdown);
  }
  return found;
}

/**
 * Marks the embed in front of it as carrying preserved source (spec FR-8.2).
 *
 * An HTML comment, so the reader sees the picture and nothing else in either
 * Obsidian mode — the same device carrying a row header, a layout's shape and an
 * inline comment's anchor. It follows the embed rather than preceding it because
 * a line *starting* with `<!--` is an HTML block in CommonMark, which would
 * swallow the embed on the same line and stop it rendering at all.
 */
export function carriedImage(id: string): string {
  return `<!--cf-img:${id}-->`;
}

const CARRIED_PATTERN = /^<!--cf-img:(cfb-\d+)-->$/;

/** The fragment id behind a carried-image marker, or `null` for ordinary HTML. */
export function readCarriedImageId(html: string): string | null {
  return CARRIED_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * Marks the **wikilink** in front of it as standing for a pasted anchor (§6.4.16).
 *
 * A fourth inline marker rather than a reuse of `cf-img`, because what it follows is a
 * *link* and not an embed, and the reverse pass has to know which of the two to look
 * for: a text run can end in either, and reading one as the other would put an
 * `<a href>` where an `<ac:image>` belongs.
 *
 * The element itself rides in the fragment rather than being rebuilt from the path.
 * It has to: the mirror's 816 anchors carry their attributes in five different orders
 * — `href`, `href rel`, `rel href`, `style href`, `href style` — and a reverse pass
 * that picked one would fail certification on the other four.
 */
export function carriedAnchor(id: string): string {
  return `<!--cf-a:${id}-->`;
}

const CARRIED_ANCHOR_PATTERN = /^<!--cf-a:(cfb-\d+)-->$/;

/** The fragment id behind a carried-anchor marker, or `null` for ordinary HTML. */
export function readCarriedAnchorId(html: string): string | null {
  return CARRIED_ANCHOR_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * Marks the embed in front of it as standing for a whole *block* (spec §6.4.8).
 *
 * A second marker rather than a second meaning for `cf-img`, because the two
 * positions cannot be told apart from the note alone: a macro alone inside a `<p>`
 * and a macro alone at body level both arrive as a paragraph holding nothing but
 * an embed. `cf-img` says *fill in this spot inside the paragraph*; this one says
 * *replace the paragraph*, `<p>` and all. Reading either one the other way round
 * changes the stored markup and makes the page read-only.
 */
export function carriedBlock(id: string): string {
  return `<!--cf-drawio:${id}-->`;
}

const CARRIED_BLOCK_PATTERN = /^<!--cf-drawio:(cfb-\d+)-->$/;

/** The fragment id behind a carried-block marker, or `null` for ordinary HTML. */
export function readCarriedBlockId(html: string): string | null {
  return CARRIED_BLOCK_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * Marks the embed in front of it as standing for an `include` macro (spec §6.4.12).
 *
 * The same *position* as `cf-drawio` — replace the paragraph, `<p>` and all — so
 * the reverse pass reads the two identically. A second name rather than a reuse
 * because what the marker sits under is a **note** embed, and a reader opening the
 * source to find `<!--cf-drawio:…-->` beneath one would be told something untrue.
 * Position is what the reverse pass needs; the name is what the reader needs.
 */
export function carriedInclude(id: string): string {
  return `<!--cf-inc:${id}-->`;
}

const CARRIED_INCLUDE_PATTERN = /^<!--cf-inc:(cfb-\d+)-->$/;

/** The fragment id behind a carried-include marker, or `null` for ordinary HTML. */
export function readCarriedIncludeId(html: string): string | null {
  return CARRIED_INCLUDE_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * Marks the embed in front of it as standing for a document-preview macro (§6.4.13).
 *
 * The same *position* again — replace the paragraph, `<p>` and all — and a third
 * name for the reason `cf-inc` was a second: what sits above this one is an embed
 * of an **attached document**, and a reader opening the source to find
 * `<!--cf-drawio:…-->` or `<!--cf-inc:…-->` beneath it would be told something
 * untrue. Position is what the reverse pass needs; the name is what the reader needs.
 */
export function carriedFile(id: string): string {
  return `<!--cf-file:${id}-->`;
}

const CARRIED_FILE_PATTERN = /^<!--cf-file:(cfb-\d+)-->$/;

/** The fragment id behind a carried-document marker, or `null` for ordinary HTML. */
export function readCarriedFileId(html: string): string | null {
  return CARRIED_FILE_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * The fragment id behind any marker that stands for a whole block.
 *
 * One reader for all three, because they mean the same thing to the trip back: the
 * paragraph *is* the macro and is replaced by it. Every call site must ask this
 * rather than any one pattern alone, or an include would inflate on one path and
 * ride into the storage as a literal comment on another.
 */
export function readBlockCarrierId(html: string): string | null {
  return readCarriedBlockId(html) ?? readCarriedIncludeId(html) ?? readCarriedFileId(html);
}

/**
 * Marks the code fence above it as standing for a `<pre>` block.
 *
 * A bare fence is otherwise indistinguishable from a code macro with no
 * language, and the reverse pass has to write one or the other — so a `<pre>`
 * used to be preserved whole rather than shown. The marker settles which it was,
 * and the fence can then be a fence.
 */
export function carriedPre(id: string): string {
  return `<!--cf-pre:${id}-->`;
}

const CARRIED_PRE_PATTERN = /^<!--cf-pre:(cfb-\d+)-->$/;

/** The fragment id behind a carried-`<pre>` marker, or `null` for ordinary HTML. */
export function readCarriedPreId(html: string): string | null {
  return CARRIED_PRE_PATTERN.exec(html.trim())?.[1] ?? null;
}

/**
 * Body of a `confluence-block` fence. Deliberately a flat `key: value` list
 * rather than JSON: it stays readable in the editor, and a user who damages it
 * produces a missing-fragment error rather than silently valid-looking data.
 */
export function blockPlaceholderBody(fragment: Fragment): string {
  const lines = [`id: ${fragment.id}`, `type: ${fragment.type}`];
  if (fragment.name !== null) lines.push(`name: ${fragment.name}`);
  if (fragment.label.length > 0) lines.push(`label: ${collapse(fragment.label)}`);
  return lines.join('\n');
}

/** Extracts a fragment id from a `confluence-block` fence body. */
export function readBlockPlaceholderId(fenceBody: string): string | null {
  for (const line of fenceBody.split('\n')) {
    const match = /^\s*id:\s*(cfb-\d+)\s*$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Single-line, trimmed, length-bounded text for a placeholder label. */
export function collapse(text: string, maxLength = 120): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= maxLength ? single : `${single.slice(0, maxLength - 1)}…`;
}
