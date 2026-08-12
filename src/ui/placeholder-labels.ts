/**
 * What each preserved fragment stands for, cached so an editor can ask synchronously.
 *
 * A placeholder's label — "Jira macro", "Confluence image" — lives in the fragment
 * sidecar, which is a file. Reading View can await it (FR-4.5). A CodeMirror
 * decoration builder cannot: it is called during a view update and must answer at
 * once. So the answer is cached, and a note whose labels have not arrived yet draws
 * the fallback pill and is redrawn when they do.
 *
 * Kept out of `live-preview-placeholders` because it is the one part with state and a
 * lifetime, and it is what a stale label would come from.
 */
export class PlaceholderLabels {
  private readonly loaded = new Map<string, ReadonlyMap<string, string>>();
  private readonly loading = new Set<string>();

  constructor(private readonly load: (notePath: string) => Promise<ReadonlyMap<string, string>>) {}

  /** The label for one fragment, or `null` if this note's labels are not in yet. */
  labelFor(notePath: string, id: string): string | null {
    return this.loaded.get(notePath)?.get(id) ?? null;
  }

  /**
   * Loads a note's labels once, then calls back so the caller can redraw.
   *
   * `onReady` fires only when something actually arrived — a note whose sidecar holds
   * no fragments must not trigger a redraw, or every keystroke in it would schedule
   * one that changes nothing.
   */
  ensure(notePath: string, onReady: () => void): void {
    if (this.loaded.has(notePath) || this.loading.has(notePath)) return;

    this.loading.add(notePath);
    void this.load(notePath).then((labels) => {
      this.loading.delete(notePath);
      this.loaded.set(notePath, labels);
      if (labels.size > 0) onReady();
    });
  }

  /**
   * Drops a note's labels because the file changed underneath them.
   *
   * A pull rewrites both the note and its sidecar, and placeholder ids are issued per
   * conversion — so after a sync the cached labels may be for ids the note no longer
   * holds, and every pill would fall back to "Confluence content" until Obsidian was
   * restarted.
   */
  forget(notePath: string): void {
    this.loaded.delete(notePath);
  }
}
