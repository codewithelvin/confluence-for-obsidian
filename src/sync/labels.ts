/**
 * Labels and tags (spec FR-9.1, FR-9.2).
 *
 * Pure string work: which of a note's tags Confluence can hold as a label, and
 * what a push has to add and remove to make the page agree with the note.
 *
 * The diff is taken against **what the plugin last wrote into the note**, not
 * against a fresh reading of the page's labels. FR-9.2 asks for the labels the
 * *user* added or removed, and that is the only comparison that answers it: a
 * note pulled before this feature existed records no labels, so its first push
 * adds the user's own tags and removes nothing — where a diff against the live
 * page would strip every label the page already had.
 */

/**
 * Characters that stop a tag from being a Confluence label.
 *
 * Confluence splits a label string on whitespace and commas, and reads `:` as a
 * namespace prefix, so a tag containing any of them would arrive as several
 * labels or as a label in somebody else's namespace. `#` is Obsidian's own tag
 * sigil and never part of the name it stores.
 */
const UNREPRESENTABLE = /[\s,:#"'\\]/;

/** Whether a tag can be sent to Confluence as a label at all (FR-9.2). */
export function isRepresentableLabel(tag: string): boolean {
  return tag.length > 0 && !UNREPRESENTABLE.test(tag);
}

/**
 * The form Confluence will actually store.
 *
 * Labels are held lower-cased, so this is what comes back on the next pull. The
 * push sends it rather than the user's casing to stop `Architecture` and
 * `architecture` looking like two different labels on either side of the trip.
 */
export function toLabel(tag: string): string {
  return tag.toLowerCase();
}

export interface LabelDiff {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  /**
   * Tags Confluence cannot hold as labels, reported rather than dropped (FR-9.2).
   *
   * A tag here is left entirely alone: it is not sent, and it does not cause the
   * removal of anything either.
   */
  readonly unrepresentable: readonly string[];
}

export const NO_LABEL_CHANGES: LabelDiff = { add: [], remove: [], unrepresentable: [] };

function keys(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map(toLabel));
}

/**
 * What a push must change, given the note's tags and the labels last recorded.
 *
 * Compared case-insensitively throughout: Confluence lower-cases what it stores,
 * so a tag that differs only in case is the same label and must not be sent
 * again — nor counted as a removal, which would delete it and add it back on
 * every push forever.
 */
export function diffLabels(tags: readonly string[], recorded: readonly string[]): LabelDiff {
  const unrepresentable = tags.filter((tag) => !isRepresentableLabel(tag));
  const wanted = tags.filter(isRepresentableLabel);

  const have = keys(recorded);
  const want = keys(wanted);

  // De-duplicated by the stored form: two tags differing only in case are one
  // label, and asking Confluence to add it twice is one wasted request each push.
  const add = [...new Set(wanted.map(toLabel))].filter((label) => !have.has(label));

  return {
    add,
    remove: recorded.filter((label) => !want.has(toLabel(label))),
    unrepresentable,
  };
}

/**
 * The labels a page holds after a diff has been applied.
 *
 * Derived rather than re-read: the labels endpoint answers with the page's whole
 * label list on every call, but a second request per pushed page to learn
 * something already known would cost one round trip per page in a batch push.
 */
export function labelsAfter(recorded: readonly string[], diff: LabelDiff): readonly string[] {
  const removed = keys(diff.remove);
  return [...recorded.filter((label) => !removed.has(toLabel(label))), ...diff.add];
}
