import { beforeEach, describe, expect, it } from 'vitest';
import type { ConflictDecision } from '../../src/sync/conflict-executor';
import type { PageConflict, PushBlocked } from '../../src/sync/push-executor';
import type { PushedPage } from '../../src/sync/push-service';
import { ConflictModal } from '../../src/ui/conflict-modal';
import { diffToLines, renderDiff } from '../../src/ui/diff-view';
import { VerificationFailureModal } from '../../src/ui/verification-modal';
import { AppError } from '../../src/util/errors';
import { App as FakeApp } from '../fakes/obsidian';

/**
 * The M5 dialogs (spec FR-5.2, FR-5.7, FR-6.2, FR-6.3, FR-6.5).
 *
 * These are smoke tests in the §8.1 sense — the UI is outside the coverage gates —
 * but three properties here are safety properties, not presentation, and are
 * asserted as such: a dismissed modal must settle the promise the push is waiting
 * on, force push must be impossible without the exact typed phrase, and no diff
 * may ever reach the DOM as markup.
 */

let app: FakeApp;

function conflict(extra: Partial<PageConflict> = {}): PageConflict {
  return {
    pageId: '1',
    title: 'Architecture',
    path: 'ENG/Architecture.md',
    localBody: 'My own edit.',
    remoteBody: 'Their newer text.',
    remoteStorage: '<p>Their newer text.</p>',
    remoteVersion: 43,
    remoteUpdatedAt: '2026-08-09T14:03:11Z',
    remoteUpdatedBy: 'j.smith',
    ...extra,
  };
}

/** Every button in a container, by its visible label. */
function buttons(root: HTMLElement): Map<string, HTMLButtonElement> {
  return new Map(
    Array.from(root.querySelectorAll('button')).map((button) => [button.textContent ?? '', button]),
  );
}

function click(root: HTMLElement, label: string): void {
  const button = buttons(root).get(label);
  if (button === undefined) throw new Error(`no button labelled "${label}"`);
  button.click();
}

beforeEach(() => {
  app = new FakeApp();
});

describe('the diff (FR-5.2, FR-6.3)', () => {
  it('marks what each side holds', () => {
    const lines = diffToLines('one\ntwo\n', 'one\nthree\n');

    expect(lines.filter((line) => line.kind === 'removed').map((l) => l.text)).toEqual(['two']);
    expect(lines.filter((line) => line.kind === 'added').map((l) => l.text)).toEqual(['three']);
  });

  it('elides a long untouched stretch instead of burying the change', () => {
    // A mirrored page runs to hundreds of lines and a typical edit touches one.
    const left = ['change me', ...Array.from({ length: 40 }, (_, i) => `line ${String(i)}`)];
    const right = ['changed', ...left.slice(1)];

    const lines = diffToLines(left.join('\n'), right.join('\n'));

    expect(lines.length).toBeLessThan(10);
    expect(lines.some((line) => line.text === '⋯')).toBe(true);
  });

  it('says so plainly when the two sides match', () => {
    const host = document.createElement('div');

    renderDiff(host, 'same\n', 'same\n', { left: 'a', right: 'b' });

    expect(host.textContent).toContain('identical');
  });

  it('never lets page content become markup (§7.4, the XSS boundary)', () => {
    const host = document.createElement('div');

    renderDiff(host, '<img src=x onerror="alert(1)">\n', 'safe\n', { left: 'a', right: 'b' });

    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('the conflict modal (FR-6.2, FR-6.3)', () => {
  it('names the page, the remote author and the remote version', () => {
    const modal = new ConflictModal(app as unknown as never, [conflict()], () => undefined);
    modal.onOpen();

    const text = modal.contentEl.textContent ?? '';
    expect(text).toContain('Architecture');
    expect(text).toContain('j.smith');
    expect(text).toContain('43');
    expect(text).toContain('ENG/Architecture.md');
  });

  it('offers exactly the three choices decision D4 allows', () => {
    const modal = new ConflictModal(app as unknown as never, [conflict()], () => undefined);
    modal.onOpen();

    const labels = [...buttons(modal.contentEl).keys()];
    expect(labels).toContain('Keep local');
    expect(labels).toContain('Keep remote');
    expect(labels).toContain('Save both');
    // No fourth option: D4 rules out merging, so there is nothing to merge with.
    expect(labels.some((label) => /merge/i.test(label))).toBe(false);
  });

  it('reports the choice for the conflict it was showing', () => {
    let decisions: readonly ConflictDecision[] = [];
    const modal = new ConflictModal(app as unknown as never, [conflict()], (result) => {
      decisions = result;
    });
    modal.onOpen();

    click(modal.contentEl, 'Keep remote');
    modal.onClose();

    expect(decisions).toEqual([{ conflict: conflict(), choice: 'keep-remote' }]);
  });

  it('walks a batch one page at a time', () => {
    const two = [conflict(), conflict({ pageId: '2', title: 'Data Model' })];
    let decisions: readonly ConflictDecision[] = [];
    const modal = new ConflictModal(app as unknown as never, two, (result) => {
      decisions = result;
    });
    modal.onOpen();

    expect(modal.contentEl.textContent).toContain('Architecture');
    click(modal.contentEl, 'Keep local');
    expect(modal.contentEl.textContent).toContain('Data Model');

    click(modal.contentEl, 'Save both');
    modal.onClose();

    expect(decisions.map((decision) => decision.choice)).toEqual(['keep-local', 'save-both']);
  });

  it('applies one choice to every remaining conflict when asked (FR-6.5)', () => {
    const three = [
      conflict(),
      conflict({ pageId: '2', title: 'B' }),
      conflict({ pageId: '3', title: 'C' }),
    ];
    let decisions: readonly ConflictDecision[] = [];
    const modal = new ConflictModal(app as unknown as never, three, (result) => {
      decisions = result;
    });
    modal.onOpen();

    const toggle = modal.contentEl.querySelector('input[type="checkbox"]');
    if (toggle === null) throw new Error('no apply-to-all toggle');
    (toggle as HTMLInputElement).checked = true;
    toggle.dispatchEvent(new Event('change'));
    click(modal.contentEl, 'Keep remote');
    modal.onClose();

    expect(decisions).toHaveLength(3);
    expect(decisions.every((decision) => decision.choice === 'keep-remote')).toBe(true);
  });

  it('offers no apply-to-all on the last conflict', () => {
    const modal = new ConflictModal(app as unknown as never, [conflict()], () => undefined);
    modal.onOpen();

    expect(modal.contentEl.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('answers nothing when dismissed, and answers exactly once', () => {
    // Dismissal is not silence: the sync is awaiting this, and an unanswered
    // conflict must leave both copies alone.
    let calls = 0;
    let decisions: readonly ConflictDecision[] | null = null;
    const modal = new ConflictModal(app as unknown as never, [conflict()], (result) => {
      calls += 1;
      decisions = result;
    });
    modal.onOpen();

    modal.onClose();
    modal.onClose();

    expect(calls).toBe(1);
    expect(decisions).toEqual([]);
  });
});

describe('the verification-failure modal (FR-5.2, FR-5.7)', () => {
  const PAGE: PushedPage = { pageId: '1', title: 'Architecture', path: 'ENG/Architecture.md' };

  function blocked(extra: Partial<PushBlocked> = {}): PushBlocked {
    return {
      error: new AppError('VERIFICATION_FAILED', 'An edit cannot be written back.', {
        action: 'show-diff',
      }),
      local: 'A _stressed_ word.',
      roundTripped: 'A *stressed* word.',
      ...extra,
    };
  }

  it('shows the user their edit against what would come back', () => {
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: false,
      onForce: () => undefined,
    });
    modal.onOpen();

    const text = modal.contentEl.textContent ?? '';
    expect(text).toContain('_stressed_');
    expect(text).toContain('*stressed*');
  });

  it('shows no diff when there are not two versions to compare', () => {
    // A lost fragment or a degraded page has nothing to diff, and inventing one
    // would be misleading.
    const modal = new VerificationFailureModal(
      app as unknown as never,
      PAGE,
      blocked({ local: null, roundTripped: null }),
      { allowForce: false, onForce: () => undefined },
    );
    modal.onOpen();

    expect(modal.contentEl.querySelector('.confluence-diff')).toBeNull();
  });

  it('does not offer force push when the setting is off', () => {
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: false,
      onForce: () => undefined,
    });
    modal.onOpen();

    expect([...buttons(modal.contentEl).keys()]).not.toContain('Force push');
  });

  it('refuses to force without the exact page title typed (FR-5.7)', () => {
    let forced = false;
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: true,
      onForce: () => {
        forced = true;
      },
    });
    modal.onOpen();

    click(modal.contentEl, 'Force push');
    expect(forced).toBe(false);

    const field = modal.contentEl.querySelector('input[type="text"]');
    if (field === null) throw new Error('no confirmation field');
    (field as HTMLInputElement).value = 'Architectur';
    (field as HTMLInputElement).dispatchEvent(new Event('input'));
    click(modal.contentEl, 'Force push');
    expect(forced).toBe(false);

    (field as HTMLInputElement).value = 'Architecture';
    (field as HTMLInputElement).dispatchEvent(new Event('input'));
    click(modal.contentEl, 'Force push');
    expect(forced).toBe(true);
  });

  it('treats dismissal as "do not force"', () => {
    let dismissed = false;
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: true,
      onForce: () => undefined,
      onDismiss: () => {
        dismissed = true;
      },
    });
    modal.onOpen();

    modal.onClose();

    expect(dismissed).toBe(true);
  });

  it('does not report dismissal after the user forced it', () => {
    let dismissed = false;
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: true,
      onForce: () => undefined,
      onDismiss: () => {
        dismissed = true;
      },
    });
    modal.onOpen();

    const field = modal.contentEl.querySelector('input[type="text"]');
    (field as HTMLInputElement).value = 'Architecture';
    (field as HTMLInputElement).dispatchEvent(new Event('input'));
    click(modal.contentEl, 'Force push');
    modal.onClose();

    expect(dismissed).toBe(false);
  });

  it('offers Confluence as the alternative when a URL is known', () => {
    let opened = false;
    const modal = new VerificationFailureModal(app as unknown as never, PAGE, blocked(), {
      allowForce: false,
      onForce: () => undefined,
      onOpenInConfluence: () => {
        opened = true;
      },
    });
    modal.onOpen();

    click(modal.contentEl, 'Open in Confluence');

    expect(opened).toBe(true);
  });
});
