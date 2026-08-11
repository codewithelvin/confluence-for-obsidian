import { diffLines } from 'diff';

/**
 * A readable line diff (spec FR-5.2, FR-6.3).
 *
 * Built with `createEl` throughout: both sides of every diff shown here are
 * Confluence page content, which is untrusted input and the plugin's primary XSS
 * boundary (§7.4). There is no path in this file by which page text becomes markup.
 */

/** Unchanged lines kept either side of a change, so a hunk reads in context. */
const CONTEXT = 2;

/** Lines rendered before the diff gives up and says how much it left out. */
const MAX_LINES = 400;

type Kind = 'added' | 'removed' | 'same';

interface DiffLine {
  readonly kind: Kind;
  readonly text: string;
}

function kindOf(part: { added?: boolean; removed?: boolean }): Kind {
  if (part.added === true) return 'added';
  if (part.removed === true) return 'removed';
  return 'same';
}

/**
 * The diff as a flat list of lines, with untouched stretches elided.
 *
 * A mirrored page runs to hundreds of lines and a typical edit touches one of
 * them; printing the rest pushes the change off the screen, which is the one thing
 * the diff exists to show.
 */
export function diffToLines(left: string, right: string): readonly DiffLine[] {
  const parts = diffLines(left, right);
  const lines: DiffLine[] = [];

  for (const [index, part] of parts.entries()) {
    const kind = kindOf(part);
    const text = part.value.replace(/\n$/, '').split('\n');

    if (kind !== 'same') {
      for (const line of text) lines.push({ kind, text: line });
      continue;
    }

    const first = index === 0;
    const last = index === parts.length - 1;
    // A leading or trailing run of unchanged lines is context on one side only;
    // an interior run is context for the change before *and* the change after.
    const head = first ? [] : text.slice(0, CONTEXT);
    const tail = last ? [] : text.slice(Math.max(head.length, text.length - CONTEXT));

    for (const line of head) lines.push({ kind, text: line });
    if (text.length > head.length + tail.length) {
      lines.push({ kind: 'same', text: '⋯' });
    }
    for (const line of tail) lines.push({ kind, text: line });
  }

  return lines;
}

const PREFIX: Readonly<Record<Kind, string>> = { added: '+', removed: '-', same: ' ' };
const CLASS: Readonly<Record<Kind, string>> = {
  added: 'confluence-diff-added',
  removed: 'confluence-diff-removed',
  same: 'confluence-diff-same',
};

export interface DiffLabels {
  readonly left: string;
  readonly right: string;
}

/** Renders the diff into `parent`, captioned so each side is unambiguous. */
export function renderDiff(
  parent: HTMLElement,
  left: string,
  right: string,
  labels: DiffLabels,
): void {
  const legend = parent.createDiv({ cls: 'confluence-diff-legend' });
  legend.createSpan({ cls: 'confluence-diff-removed', text: `− ${labels.left}` });
  legend.createSpan({ cls: 'confluence-diff-added', text: `+ ${labels.right}` });

  const lines = diffToLines(left, right);
  const body = parent.createEl('pre', { cls: 'confluence-diff' });

  if (lines.every((line) => line.kind === 'same')) {
    body.createDiv({ cls: 'confluence-diff-same', text: 'The two versions are identical.' });
    return;
  }

  for (const line of lines.slice(0, MAX_LINES)) {
    body.createDiv({ cls: CLASS[line.kind], text: `${PREFIX[line.kind]} ${line.text}` });
  }

  const hidden = lines.length - MAX_LINES;
  if (hidden > 0) {
    body.createDiv({
      cls: 'confluence-diff-same',
      text: `⋯ and ${String(hidden)} more line(s). Open the page in Confluence to see it all.`,
    });
  }
}
