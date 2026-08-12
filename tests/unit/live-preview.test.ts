import { describe, expect, it, vi } from 'vitest';
import { findInlinePlaceholders } from '../../src/convert/placeholder-registry';
import { pillRanges } from '../../src/ui/live-preview-placeholders';
import { PlaceholderLabels } from '../../src/ui/placeholder-labels';
import { inlinePlaceholderPill } from '../../src/ui/placeholder-renderer';

/**
 * FR-4.5's inline pill in Live Preview (decision D16).
 *
 * The editor half cannot ask the DOM what a `<code>` element holds — there is no
 * rendered element yet — so it reads the sentinel out of the *source text*. That is
 * a second implementation of the same grammar, which D16 names as the risk, and
 * these are the tests that keep the two honest.
 */

describe('findInlinePlaceholders (the sentinel in source form)', () => {
  it('finds a sentinel with the backticks that carry it', () => {
    expect(findInlinePlaceholders('before `{cf:cfb-0007}` after')).toEqual([
      { id: 'cfb-0007', from: 7, to: 22 },
    ]);
  });

  it('finds every sentinel on a line, in document order', () => {
    const found = findInlinePlaceholders('`{cf:cfb-0001}` and `{cf:cfb-0002}`');

    expect(found.map((match) => match.id)).toEqual(['cfb-0001', 'cfb-0002']);
    expect(found.map((match) => match.from)).toEqual([0, 20]);
  });

  it('leaves ordinary inline code alone', () => {
    expect(findInlinePlaceholders('`npm run verify` and `{cf:nonsense}`')).toEqual([]);
  });

  it('requires the backticks — a bare sentinel in prose is not one', () => {
    expect(findInlinePlaceholders('the literal {cf:cfb-0007} in prose')).toEqual([]);
  });

  it('is not affected by a previous scan', () => {
    // A shared global regex carries `lastIndex` between calls, which would make the
    // second scan of the same text return nothing.
    const text = '`{cf:cfb-0001}`';
    expect(findInlinePlaceholders(text)).toEqual(findInlinePlaceholders(text));
  });

  it('agrees with the rendered-HTML reader about what counts', () => {
    const source = '`{cf:cfb-0042}`';
    const [match] = findInlinePlaceholders(source);

    expect(match?.id).toBe('cfb-0042');
    // The Reading View half is handed the code element's text, without backticks.
    expect(source.slice(1, -1)).toBe(`{cf:${match?.id ?? ''}}`);
  });
});

describe('pillRanges', () => {
  const never = (): boolean => false;

  it('offsets each match by the window it was found in', () => {
    const windows = [{ from: 100, text: 'x `{cf:cfb-0001}` y' }];

    expect(pillRanges(windows, never)).toEqual([{ id: 'cfb-0001', from: 102, to: 117 }]);
  });

  it('covers every visible window', () => {
    const windows = [
      { from: 0, text: '`{cf:cfb-0001}`' },
      { from: 500, text: '`{cf:cfb-0002}`' },
    ];

    expect(pillRanges(windows, never).map((range) => range.from)).toEqual([0, 500]);
  });

  it('gives the text back where the selection touches it', () => {
    // A reader who selects a placeholder means to delete it, and a widget they
    // cannot see into would swallow the caret.
    const windows = [{ from: 0, text: '`{cf:cfb-0001}` `{cf:cfb-0002}`' }];
    const touches = (from: number): boolean => from === 0;

    expect(pillRanges(windows, touches).map((range) => range.id)).toEqual(['cfb-0002']);
  });

  it('finds nothing in a note with no placeholders', () => {
    expect(pillRanges([{ from: 0, text: 'ordinary prose' }], never)).toEqual([]);
  });
});

describe('the pill itself', () => {
  it('shows the label and hides the id in the tooltip', () => {
    const pill = inlinePlaceholderPill(document, 'cfb-0007', 'jira macro');

    expect(pill.textContent).toBe('jira macro');
    expect(pill.getAttribute('title')).toContain('cfb-0007');
    expect(pill.className).toBe('confluence-inline-placeholder');
  });

  it('falls back to a neutral name before the labels have loaded', () => {
    expect(inlinePlaceholderPill(document, 'cfb-0007', null).textContent).toBe(
      'Confluence content',
    );
    expect(inlinePlaceholderPill(document, 'cfb-0007', '').textContent).toBe('Confluence content');
  });

  it('never parses a label as markup', () => {
    // Labels are derived from page content, which is untrusted input (§7.4).
    const pill = inlinePlaceholderPill(document, 'cfb-0007', '<img src=x onerror=alert(1)>');

    expect(pill.querySelector('img')).toBeNull();
    expect(pill.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('PlaceholderLabels', () => {
  function labels(entries: [string, string][] = [['cfb-0001', 'jira macro']]) {
    const load = vi.fn((_path: string) => Promise.resolve(new Map(entries)));
    return { load, cache: new PlaceholderLabels(load) };
  }

  it('answers nothing until the note has been loaded', () => {
    const { cache } = labels();
    expect(cache.labelFor('EP/A.md', 'cfb-0001')).toBeNull();
  });

  it('answers from the cache once loaded, and redraws only then', async () => {
    const { cache } = labels();
    const onReady = vi.fn();

    cache.ensure('EP/A.md', onReady);
    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledOnce();
    });

    expect(cache.labelFor('EP/A.md', 'cfb-0001')).toBe('jira macro');
  });

  it('loads a note once however often it is asked', async () => {
    const { cache, load } = labels();

    cache.ensure('EP/A.md', () => undefined);
    cache.ensure('EP/A.md', () => undefined);
    await vi.waitFor(() => {
      expect(cache.labelFor('EP/A.md', 'cfb-0001')).toBe('jira macro');
    });
    cache.ensure('EP/A.md', () => undefined);

    expect(load).toHaveBeenCalledOnce();
  });

  it('does not ask for a redraw when the note has no fragments', async () => {
    const { cache } = labels([]);
    const onReady = vi.fn();

    cache.ensure('EP/A.md', onReady);
    await vi.waitFor(() => {
      expect(cache.labelFor('EP/A.md', 'anything')).toBeNull();
    });

    expect(onReady).not.toHaveBeenCalled();
  });

  it('reloads a note whose fragments were rewritten by a pull', async () => {
    const { cache, load } = labels();

    cache.ensure('EP/A.md', () => undefined);
    await vi.waitFor(() => {
      expect(cache.labelFor('EP/A.md', 'cfb-0001')).toBe('jira macro');
    });

    cache.forget('EP/A.md');
    expect(cache.labelFor('EP/A.md', 'cfb-0001')).toBeNull();

    cache.ensure('EP/A.md', () => undefined);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
