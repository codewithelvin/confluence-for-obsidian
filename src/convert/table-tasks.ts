import { preserveBeside } from './placeholder-factory';
import { childrenOf, tagOf } from './storage-parser';
import type { ConversionContext } from './types';

/**
 * Task lists inside a preserved table (spec §6.4.14, decision D23, FR-4.21).
 *
 * §6.4.10 taught a refused table to show its pictures and its file links, and left
 * a census of what still hid one. Six of those tables hold an `ac:task-list`, and
 * on three of them the table *is* the note: the UAT review pages of space EP —
 * `Bildirişlər altmodulu - UAT`, `Vergi ödəyicisinin profili - UAT`, `Bank
 * hesabları üzrə əməliyyatların dondurulması qərarları altmodulu - UAT` — are one
 * feedback table each, so the reader was shown a title, a grey pill, and nothing
 * else. Behind the pill sat the reviewers' names and eight paragraphs of what they
 * wanted changed.
 *
 * A task list already converts perfectly well *outside* a table: §6.4.2 writes it
 * as Markdown checkboxes and carries the Confluence task id beside each one. Inside
 * a preserved table that route is closed, for the reason §6.4.10 gives — a preserved
 * table is a raw HTML block, and CommonMark keeps an HTML block's content raw, so
 * `- [ ]` there is literal text. It has to be HTML or it is nothing.
 *
 * So each task becomes a list item led by a Unicode ballot box. A real
 * `<input type="checkbox">` would look better, but O18 probed `<img>` and `<a>`
 * rather than form controls, and a glyph needs no probe to be certain of: it is
 * text, and §6.4.9 already leans on exactly that certainty when it maps an emoticon
 * to its character. The boxes are not interactive — nor should they be, because
 * ticking one here could not travel back to the task in Confluence.
 */

/** Ballot boxes, empty and checked. Text, so nothing has to render an element. */
const UNCHECKED = '☐';
const CHECKED = '☑';

/** A space after the box, so the glyph does not run into the first word. */
const GLYPH_GAP = ' ';

/**
 * The class that marks the projection as ours.
 *
 * The reverse pass has to find the whole `<ul>` to put the task list back, and a
 * table can legitimately hold a `<ul>` its author wrote. Without the class the
 * pattern would match one of those whenever a carrier happened to follow it, and
 * swallow the author's list into a fragment that never described it.
 */
const TASK_CLASS = 'cf-tasks';

/**
 * The projected list, for the pattern that reads it back (§6.4.10's `PROJECTED`).
 *
 * Lazy up to the first `</ul>`, which is exact here because a projected list never
 * contains another: a nested `ac:task-list` is namespaced markup inside the task
 * body, and `taskListElement` refuses on that before anything is allocated.
 */
export const PROJECTED_TASK_LIST = `<ul class="${TASK_CLASS}">[\\s\\S]*?</ul>`;

/** The four tags a task list is built from — everything else in it is content. */
const TASK_TAGS = new Set([
  'ac:task-list',
  'ac:task',
  'ac:task-id',
  'ac:task-status',
  'ac:task-body',
]);

/**
 * Whether the list holds namespaced markup of its own.
 *
 * A task body may hold an image, a page link or a macro, and none of those can be
 * shown by moving it into a list item — so the whole table stays preserved, exactly
 * as it does today. Three of the mirror's six such tables fail here.
 *
 * Deliberately checked *before* §6.4.10 projects the table's media, so a picture
 * inside a task body is never half-translated: the projected `<ul>` would then hold
 * a carrier of its own inside a carrier, and the reverse pass would have to unpick
 * which of the two owned the picture.
 */
function holdsNamespacedMarkup(list: Element): boolean {
  return Array.from(list.getElementsByTagName('*')).some((descendant) => {
    const tag = tagOf(descendant);
    return (tag.startsWith('ac:') || tag.startsWith('ri:')) && !TASK_TAGS.has(tag);
  });
}

/** A task's status element says `complete`; anything else is unchecked. */
function isComplete(task: Element): boolean {
  for (const child of childrenOf(task)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as Element;
    if (tagOf(element) !== 'ac:task-status') continue;
    return (element.textContent ?? '').trim() === 'complete';
  }
  return false;
}

function bodyOf(task: Element): Element | null {
  for (const child of childrenOf(task)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as Element;
    if (tagOf(element) === 'ac:task-body') return element;
  }
  return null;
}

/**
 * The `<ul>` for an `ac:task-list`, or `null` when it cannot honestly be shown.
 *
 * The body's child nodes are **deep-copied** rather than read as text: a task body
 * carries ordinary inline formatting — bold, a `<span>`, a line break — and
 * `textContent` would flatten all of it.
 *
 * Copied, emphatically not moved. `preserveBeside` serialises the original list
 * into the fragment *after* this runs, so a list whose bodies had been emptied into
 * the projection would be stored hollow — and the push would then hand Confluence
 * a table of tasks with no text in them.
 *
 * The task id is not shown. Outside a table §6.4.2 carries it in a comment beside
 * the checkbox, because there the checkbox is Markdown the user may reorder; here
 * the whole list is replaced by its fragment on the way back, so the id travels in
 * the fragment and needs no carrier of its own.
 */
function taskListElement(list: Element): Element | null {
  if (holdsNamespacedMarkup(list)) return null;

  const document = list.ownerDocument;
  const projected = document.createElement('ul');
  projected.setAttribute('class', TASK_CLASS);

  for (const child of childrenOf(list)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const task = child as Element;
    if (tagOf(task) !== 'ac:task') continue;

    const body = bodyOf(task);
    if (body === null) return null;

    const item = document.createElement('li');
    item.appendChild(
      document.createTextNode(`${isComplete(task) ? CHECKED : UNCHECKED}${GLYPH_GAP}`),
    );
    for (const node of childrenOf(body)) item.appendChild(node.cloneNode(true));

    projected.appendChild(item);
  }

  // A list with no task in it renders as an empty bullet list, which says less than
  // the widget it would replace.
  return projected.childNodes.length === 0 ? null : projected;
}

/**
 * Replaces every task list in a *copy* of a table with the list that shows it, so
 * the table stops counting as namespaced markup.
 *
 * Mutates. Returns `false` as soon as one of them cannot be shown, and the caller
 * then keeps the whole table preserved. All-or-nothing for the reason
 * `hideEmoticonsIn` and `hideTableMediaIn` are: a table half-translated would show
 * a gap exactly where FR-4.9 says it must not.
 *
 * Planned in full before anything is allocated, because `preserveBeside` takes the
 * next fragment id as a side effect — the trap §6.4.10 records.
 */
export function hideTaskListsIn(clone: Element, ctx: ConversionContext): boolean {
  const planned: { readonly list: Element; readonly shown: Element }[] = [];

  for (const list of Array.from(clone.getElementsByTagName('ac:task-list'))) {
    if (list.parentNode === null) return false;

    const shown = taskListElement(list);
    if (shown === null) return false;

    planned.push({ list, shown });
  }

  const document = clone.ownerDocument;
  for (const { list, shown } of planned) {
    const id = preserveBeside(ctx.placeholders, list, {
      type: 'task-list',
      label: 'shown inside a preserved table',
    });

    const parent = list.parentNode as Node;
    parent.insertBefore(shown, list);
    parent.insertBefore(document.createComment(`cf-tbl:${id}`), list);
    parent.removeChild(list);
  }
  return true;
}
