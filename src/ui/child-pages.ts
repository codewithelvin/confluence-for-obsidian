import type { App } from 'obsidian';
import type { FragmentMap } from '../convert/types';
import { asNonEmptyString, isRecord, readPath } from '../util/guards';
import { CONFLUENCE_KEY } from '../vault/frontmatter';

/**
 * Which pages are a page's children, read off the vault (spec §6.4.11, FR-4.18).
 *
 * A `children` macro holds nothing: Confluence builds the list at render time from
 * the page tree. The vault mirrors that tree — under D9/D13 a page's children are
 * laid out as the contents of its folder — so the list can be rebuilt locally and
 * the reader gets navigation instead of a grey widget.
 *
 * Nothing here is written to a note. The macro stays a placeholder, its fragment
 * keeps its source, and push and certification never see any of this.
 *
 * Kept out of `placeholder-renderer` because it is a question about the vault, not
 * about the DOM, and it is the half worth testing without one.
 */

/** One entry in a rebuilt child list. */
export interface ChildPage {
  /** What the link shows — the note's file name, as the file explorer shows it. */
  readonly title: string;
  /** Vault-root-relative path of the note, `.md` included. */
  readonly path: string;
}

/**
 * A note that could be a child, as the vault presents it.
 *
 * Structural rather than Obsidian's `TFile`, so the rule is testable without a
 * vault and the Obsidian types stay in `main.ts` where the app object lives.
 */
export interface CandidateNote {
  readonly title: string;
  readonly path: string;
  /** `confluence.parent` from the note's frontmatter, or `null` for a personal note. */
  readonly parentId: string | null;
}

/**
 * Whether a `children` macro lists the children of the page it sits on.
 *
 * A whitelist, and deliberately a blunt one: **only a parameterless macro** is
 * rebuilt. The parameter that matters is `page=`, which points the list at a
 * *different* page — three of those are in the mirror, and drawing this page's
 * children under one of them would be confidently wrong. Refusing every
 * parameterised macro instead of learning which of Confluence's eight change the
 * result costs nothing measurable: all 57 block `children` macros in the mirror
 * carry none.
 *
 * The fragment source is read, never parsed and never rendered — the XHTML is not
 * allowed anywhere near the DOM (§7.4).
 */
export function listsOwnChildren(xhtml: string): boolean {
  return !xhtml.includes('<ac:parameter');
}

/**
 * The child pages of a page, from the notes beside its own.
 *
 * Matched on frontmatter `parent`, not on where the file sits: a page's children
 * are pages and not files (§6.5), so a personal note dropped into the folder is
 * not a child, and neither is a sibling page in a folder shared with it.
 *
 * Alphabetical, because Confluence's manual tree order is not mirrored anywhere in
 * the vault (§6.4.11). It matches the order the file explorer shows beside the
 * note, so the reader meets one order rather than two.
 *
 * The note itself needs no excluding: its own `parent` is its *parent's* id, and no
 * page is its own parent.
 */
export function childPagesOf(
  pageId: string | null,
  candidates: readonly CandidateNote[],
): readonly ChildPage[] {
  if (pageId === null || pageId.length === 0) return [];

  return candidates
    .filter((candidate) => candidate.parentId === pageId)
    .map((candidate) => ({ title: candidate.title, path: candidate.path }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

/**
 * A vault entry as the walk needs to see it. Obsidian's `TFile` and `TFolder` both
 * satisfy it, which is what keeps this half testable without a vault.
 */
export interface VaultEntry {
  readonly name: string;
  readonly path: string;
  /** A file only. */
  readonly basename?: string;
  readonly extension?: string;
  /** A folder only — and what tells the two apart. */
  readonly children?: readonly VaultEntry[];
}

/** The note a folder belongs to: `Title/Title.md` (decision D9). */
function folderNoteIn(folder: VaultEntry): VaultEntry | null {
  return folder.children?.find((child) => child.basename === folder.name) ?? null;
}

/**
 * Every note in a page's folder that could be one of its children.
 *
 * The folder and one level down — where a subfolder contributes only its *folder
 * note*, because that is the note a child page with children of its own owns. Never
 * the whole vault: a child the user has dragged elsewhere is not listed, which is
 * the honest answer, and scanning 1 469 notes on every render to find it would cost
 * more than the list is worth.
 */
export function candidatesIn(
  entries: readonly VaultEntry[],
  parentIdOf: (path: string) => string | null,
): readonly CandidateNote[] {
  const candidates: CandidateNote[] = [];

  for (const entry of entries) {
    const note = entry.children === undefined ? entry : folderNoteIn(entry);
    if (note === null || note.extension !== 'md') continue;
    candidates.push({
      title: note.basename ?? note.name,
      path: note.path,
      parentId: parentIdOf(note.path),
    });
  }
  return candidates;
}

/** The fragment cache as the source needs it — `NoteService` satisfies this. */
export interface FragmentSource {
  readonly fragmentsFor: (notePath: string) => Promise<FragmentMap>;
}

/**
 * The renderer's `childPagesFor` dependency, bound to a real vault (FR-4.18).
 *
 * Answers with an empty list wherever the vault cannot answer honestly, which the
 * renderer reads as "draw the labelled widget instead": a fragment that is no longer
 * cached, a macro carrying a parameter that may name a different page, a note
 * outside the vault, or a page with no children.
 *
 * The metadata cache is Obsidian's own parsed index, not vault I/O, so reading it
 * here does not go through `VaultGateway` — the same reading as FR-4.5's `toc` path.
 */
export function childPageSource(
  app: App,
  notes: FragmentSource,
): (notePath: string, placeholderId: string) => Promise<readonly ChildPage[]> {
  const field = (notePath: string, name: string): string | null => {
    const frontmatter = app.metadataCache.getCache(notePath)?.frontmatter;
    return isRecord(frontmatter)
      ? asNonEmptyString(readPath(frontmatter, CONFLUENCE_KEY, name))
      : null;
  };

  return async (notePath, placeholderId) => {
    const fragment = (await notes.fragmentsFor(notePath)).get(placeholderId);
    if (fragment === undefined || !listsOwnChildren(fragment.xhtml)) return [];

    const folder = app.vault.getFileByPath(notePath)?.parent ?? null;
    if (folder === null) return [];

    return childPagesOf(
      field(notePath, 'id'),
      candidatesIn(folder.children, (path) => field(path, 'parent')),
    );
  };
}
