import { describe, expect, it } from 'vitest';
import { markdownToStorage } from '../../src/convert/markdown-to-storage';
import { certify } from '../../src/convert/round-trip-verifier';
import { storageToMarkdown } from '../../src/convert/storage-to-markdown';
import type { ConversionOptions } from '../../src/convert/types';

/**
 * Task lists inside a preserved table (spec §6.4.14, D23, FR-4.21).
 *
 * The table here is `Bildirişlər altmodulu - UAT` (page 38554517) reduced to its
 * shape: a three-column header, a task list in the first cell of a data row, a
 * reviewer's name beside it, and the `colspan="1"` Confluence writes on cells that
 * span nothing. That `colspan` is what refuses GFM; the task list is what used to
 * refuse the HTML projection as well, leaving the note a title and one grey pill.
 */

const OPTIONS: ConversionOptions = {
  baseUrl: 'https://confluence.cybernet.az',
  spaceKey: 'EP',
};

function task(id: string, body: string, status = 'incomplete'): string {
  return (
    '<ac:task>\n' +
    `<ac:task-id>${id}</ac:task-id>\n` +
    `<ac:task-status>${status}</ac:task-status>\n` +
    `<ac:task-body>${body}</ac:task-body>\n` +
    '</ac:task>\n'
  );
}

function taskList(...tasks: string[]): string {
  return `<ac:task-list>\n${tasks.join('')}</ac:task-list>`;
}

/** The UAT feedback table, as space EP stores it. */
function uatTable(cell: string): string {
  return (
    '<table><tbody>' +
    '<tr><th><p>Müraciətin məzmunu</p></th><th>DVX tərəfdən məsul şəxs</th>' +
    '<th colspan="1">Şərhlər</th></tr>' +
    `<tr><td>${cell}</td><td>Ülviyyə Mirzəliyeva</td><td colspan="1"/></tr>` +
    '</tbody></table>'
  );
}

function convert(storage: string): string {
  const result = storageToMarkdown(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.markdown.trimEnd();
}

function certified(storage: string): boolean {
  const result = certify(storage, OPTIONS);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.value.certified;
}

function push(markdown: string, storage: string): string {
  const forward = storageToMarkdown(storage, OPTIONS);
  if (!forward.ok) throw new Error(forward.error.userMessage);

  const back = markdownToStorage(markdown, forward.value.fragments, OPTIONS);
  if (!back.ok) throw new Error(back.error.userMessage);
  return back.value;
}

describe('a task list inside a preserved table', () => {
  it('is shown as a bullet list of ballot boxes rather than hiding the table', () => {
    const markdown = convert(uatTable(taskList(task('2', 'Bildirişlər boşdur.'))));

    expect(markdown).toContain('<ul class="cf-tasks">');
    expect(markdown).toContain('<li>☐ Bildirişlər boşdur.</li>');
    // The rest of the table is now visible too — which was the whole point.
    expect(markdown).toContain('Müraciətin məzmunu');
    expect(markdown).toContain('Ülviyyə Mirzəliyeva');
    expect(markdown).not.toContain('```confluence-block');
  });

  it('ticks a completed task', () => {
    const markdown = convert(uatTable(taskList(task('3', 'Düzəldilib.', 'complete'))));
    expect(markdown).toContain('<li>☑ Düzəldilib.</li>');
  });

  it('leaves the box empty for a task with no status element at all', () => {
    const storage = uatTable(
      '<ac:task-list>\n<ac:task><ac:task-id>8</ac:task-id>' +
        '<ac:task-body>Statussuz</ac:task-body></ac:task>\n</ac:task-list>',
    );
    expect(convert(storage)).toContain('<li>☐ Statussuz</li>');
  });

  it('shows every task in a list, in order', () => {
    // Page 38554513 carries a cell of eight.
    const markdown = convert(
      uatTable(taskList(task('9', 'Birinci'), task('10', 'İkinci'), task('11', 'Üçüncü'))),
    );

    expect(markdown).toContain('<li>☐ Birinci</li><li>☐ İkinci</li><li>☐ Üçüncü</li>');
  });

  it('keeps inline formatting inside a task body', () => {
    const markdown = convert(uatTable(taskList(task('4', 'adı <strong>dəyişdirilməli</strong>'))));
    expect(markdown).toContain('<li>☐ adı <strong>dəyişdirilməli</strong></li>');
  });

  it('hands Confluence back the identical table, so the page stays certified', () => {
    const storage = uatTable(taskList(task('2', 'Bildirişlər boşdur.')));
    expect(certified(storage)).toBe(true);
  });

  it('puts the task list back with its ids and statuses intact', () => {
    const storage = uatTable(taskList(task('9', 'Birinci'), task('10', 'İkinci', 'complete')));
    const restored = push(convert(storage), storage);

    expect(restored).toBe(storage);
    expect(restored).toContain('<ac:task-id>9</ac:task-id>');
    expect(restored).toContain('<ac:task-status>complete</ac:task-status>');
  });

  it('stores the original list, not the hollow one left after projection', () => {
    // The projection copies the task bodies; moving them would empty the element
    // `preserveBeside` is about to serialise, and the push would then send
    // Confluence a table of tasks with no text in them.
    const storage = uatTable(taskList(task('2', 'Bildirişlər boşdur.')));
    expect(push(convert(storage), storage)).toContain(
      '<ac:task-body>Bildirişlər boşdur.</ac:task-body>',
    );
  });
});

describe('a task list a preserved table cannot show', () => {
  it('still refuses the table when a task body holds namespaced markup', () => {
    // Three of the mirror's six such tables fail here. Projecting the picture first
    // and the list second would nest one carrier inside another, and the reverse
    // pass would have to unpick which of the two owned the picture.
    const body = 'bax <ac:image><ri:attachment ri:filename="shot.png"/></ac:image>';
    const markdown = convert(uatTable(taskList(task('5', body))));

    expect(markdown).toContain('```confluence-block');
    expect(markdown).toContain('type: table');
  });

  it('refuses a task with no body at all', () => {
    const storage = uatTable(
      '<ac:task-list>\n<ac:task><ac:task-id>7</ac:task-id></ac:task>\n</ac:task-list>',
    );
    expect(convert(storage)).toContain('```confluence-block');
  });

  it('refuses an empty task list', () => {
    expect(convert(uatTable('<ac:task-list>\n</ac:task-list>'))).toContain('```confluence-block');
  });
});

describe('an edited note holding a shown task list', () => {
  it('puts the list back when the user deleted it and left the marker', () => {
    const storage = uatTable(taskList(task('2', 'Bildirişlər boşdur.')));
    const markdown = convert(storage);
    const stripped = markdown.replace(/<ul class="cf-tasks">[\s\S]*?<\/ul>/, '');

    expect(push(stripped, storage)).toBe(storage);
  });

  it('leaves a list the author wrote alone', () => {
    // A table can hold a `<ul>` of its own. Without the `cf-tasks` class the
    // reverse pattern would swallow it into a fragment that never described it.
    const storage = uatTable(`<ul><li>author's own</li></ul>${taskList(task('2', 'Bir'))}`);
    const restored = push(convert(storage), storage);

    expect(restored).toBe(storage);
    expect(restored).toContain("<ul><li>author's own</li></ul>");
  });
});
