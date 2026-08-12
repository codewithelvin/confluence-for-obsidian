import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, EditorView, PluginValue, ViewUpdate } from '@codemirror/view';
import {
  findInlinePlaceholders,
  type InlinePlaceholderMatch,
} from '../convert/placeholder-registry';
import { inlinePlaceholderPill } from './placeholder-renderer';

/**
 * FR-4.5's inline pill in **Live Preview** (decision D16).
 *
 * Reading View replaces a rendered `<code>` element; there is no such element while
 * the user is editing, because Live Preview decorates the source text itself. So the
 * same sentinel is found twice, by two different means — which is exactly the risk
 * D16 records, and why the grammar lives once in `placeholder-registry` and the pill
 * is built once in `placeholder-renderer`. Only the plumbing differs.
 *
 * This was the mode the 2026-08-11 UX read found showing a literal `{cf:cfb-0007}`
 * to the reader, which FR-4.5 forbids in as many words.
 *
 * `@codemirror/view` and `@codemirror/state` are types-only devDependencies: Obsidian
 * provides both at runtime and both are `external` in the bundle, so the shipped
 * plugin gains zero bytes (D16, §5.2).
 */

/** A stretch of the document the editor is actually showing. */
export interface SourceWindow {
  /** Document offset the text starts at. */
  readonly from: number;
  readonly text: string;
}

/**
 * Which sentinels to draw a pill over, in document order.
 *
 * A sentinel the selection touches is deliberately left as raw text. Replacing it
 * would put the caret inside a widget the user cannot see into, and the one thing a
 * reader might legitimately want to do with a placeholder in the editor is select it
 * and delete it.
 *
 * Pure, and separate from the CodeMirror plumbing, because this is the whole of the
 * decision and it should be testable without an editor.
 */
export function pillRanges(
  windows: readonly SourceWindow[],
  touchesSelection: (from: number, to: number) => boolean,
): readonly InlinePlaceholderMatch[] {
  const ranges: InlinePlaceholderMatch[] = [];

  for (const window of windows) {
    for (const match of findInlinePlaceholders(window.text)) {
      const from = window.from + match.from;
      const to = window.from + match.to;
      if (touchesSelection(from, to)) continue;
      ranges.push({ id: match.id, from, to });
    }
  }
  return ranges;
}

/** The pill, as a CodeMirror widget. */
class PlaceholderPillWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly label: string | null,
  ) {
    super();
  }

  /** Lets CodeMirror keep the existing DOM when a redraw changes nothing. */
  override eq(other: PlaceholderPillWidget): boolean {
    return other.id === this.id && other.label === this.label;
  }

  override toDOM(view: EditorView): HTMLElement {
    return inlinePlaceholderPill(view.dom.ownerDocument, this.id, this.label);
  }
}

export interface LivePreviewPlaceholderDeps {
  /** The note being edited in this view, or `null` when there is no file behind it. */
  readonly pathFor: (view: EditorView) => string | null;
  /** `false` in source mode, where showing the raw sentinel is the point. */
  readonly isLivePreview: (view: EditorView) => boolean;
  /**
   * What a fragment id stands for, or `null` while the note's labels are still being
   * read. Synchronous by necessity — a decoration builder cannot await.
   */
  readonly labelFor: (notePath: string, id: string) => string | null;
  /**
   * Asks for a note's labels to be loaded, calling back once they arrive so the view
   * can be redrawn with real names instead of the fallback.
   */
  readonly ensureLabels: (notePath: string, onReady: () => void) => void;
}

/** The editor extension to hand to `Plugin.registerEditorExtension`. */
export function inlinePlaceholderExtension(deps: LivePreviewPlaceholderDeps): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view, deps);
      }

      update(update: ViewUpdate): void {
        // Selection too: a caret moving into a sentinel has to give the text back.
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = build(update.view, deps);
        }
      }
    },
    { decorations: (value) => value.decorations },
  );
}

function build(view: EditorView, deps: LivePreviewPlaceholderDeps): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  const notePath = deps.pathFor(view);
  if (notePath === null || !deps.isLivePreview(view)) return builder.finish();

  const windows = view.visibleRanges.map((range) => ({
    from: range.from,
    text: view.state.sliceDoc(range.from, range.to),
  }));
  const ranges = pillRanges(windows, (from, to) =>
    view.state.selection.ranges.some((range) => range.from <= to && range.to >= from),
  );
  if (ranges.length === 0) return builder.finish();

  // Only now: a note with no sentinels never touches the fragment cache. The
  // callback runs from a settled promise, so dispatching here cannot re-enter an
  // update that is still in progress.
  deps.ensureLabels(notePath, () => {
    view.dispatch({});
  });

  for (const range of ranges) {
    builder.add(
      range.from,
      range.to,
      Decoration.replace({
        widget: new PlaceholderPillWidget(range.id, deps.labelFor(notePath, range.id)),
      }),
    );
  }
  return builder.finish();
}
