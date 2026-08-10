import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from '../../src/api/confluence-client';
import { DEFAULT_RETRY, Semaphore } from '../../src/api/rate-limiter';
import { observeFormat, probeSpaceFidelity } from '../../src/diagnostics/fidelity-probe';
import { formatFidelityReport } from '../../src/diagnostics/fidelity-report';
import { Logger } from '../../src/util/logger';
import type { HttpResponse } from '../../src/api/http-transport';
import { jsonResponse, recordingTransport, testScheduler } from '../fakes/http';

const BASE_URL = 'https://confluence.cybernet.az';
const silentLogger = new Logger('test', () => false);

function client(script: readonly HttpResponse[]) {
  return new ConfluenceClient(BASE_URL, () => 'PAT', {
    transport: recordingTransport(script),
    semaphore: new Semaphore(4),
    scheduler: testScheduler(),
    retry: DEFAULT_RETRY,
    logger: silentLogger,
    pageSize: 50,
  });
}

function page(id: string, storage: string, title = `Page ${id}`) {
  return {
    id,
    title,
    space: { key: 'TT' },
    version: { number: 1 },
    ancestors: [],
    body: { storage: { value: storage } },
  };
}

describe('observeFormat', () => {
  it('spots table cells wrapping content in a paragraph', () => {
    expect(observeFormat('<table><tr><th><p>A</p></th></tr></table>')).toContain(
      'tableCellsWithParagraphs',
    );
  });

  it('spots table cells holding content directly', () => {
    expect(observeFormat('<table><tr><th>A</th></tr></table>')).toContain('tableCellsBare');
  });

  it('does not confuse the two forms', () => {
    const wrapped = observeFormat('<table><tr><td><p>A</p></td></tr></table>');
    expect(wrapped.has('tableCellsBare')).toBe(false);
  });

  it('spots server-generated identity attributes', () => {
    expect(observeFormat('<ac:structured-macro ac:macro-id="x"/>')).toContain('withMacroId');
    expect(observeFormat('<table ac:local-id="x"/>')).toContain('withLocalId');
    expect(observeFormat('<ac:structured-macro ac:schema-version="1"/>')).toContain(
      'withSchemaVersion',
    );
  });

  it('spots inline comment markers', () => {
    expect(
      observeFormat('<ac:inline-comment-marker ac:ref="1">x</ac:inline-comment-marker>'),
    ).toContain('withInlineComments');
  });

  it('spots page links that omit the space key', () => {
    expect(observeFormat('<ri:page ri:content-title="X"/>')).toContain(
      'withPageLinksMissingSpaceKey',
    );
    expect(
      observeFormat('<ri:page ri:content-title="X" ri:space-key="TT"/>').has(
        'withPageLinksMissingSpaceKey',
      ),
    ).toBe(false);
  });

  it('reports nothing for plain content', () => {
    expect(observeFormat('<p>plain</p>').size).toBe(0);
  });
});

describe('probeSpaceFidelity', () => {
  it('classifies each sampled page', async () => {
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({
          results: [
            { id: '1', title: 'Clean' },
            { id: '2', title: 'Commented' },
          ],
        }),
        jsonResponse(page('1', '<h1>Title</h1><p>Body.</p>')),
        jsonResponse(
          page(
            '2',
            '<p>A <ac:inline-comment-marker ac:ref="r">note</ac:inline-comment-marker>.</p>',
          ),
        ),
      ]),
      'TT',
      { baseUrl: BASE_URL, limit: 50 },
    );

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.sampled).toBe(2);
    expect(probe.value.certified).toBe(1);
    expect(probe.value.degraded).toBe(1);
    expect(probe.value.observations.withInlineComments).toBe(1);
  });

  it('keeps the storage of a failing page so the cause can be inspected', async () => {
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({ results: [{ id: '1', title: 'Commented' }] }),
        jsonResponse(
          page('1', '<p><ac:inline-comment-marker ac:ref="r">x</ac:inline-comment-marker></p>'),
        ),
      ]),
      'TT',
      { baseUrl: BASE_URL, limit: 50 },
    );

    expect(probe.ok && probe.value.pages[0]?.storage).toContain('inline-comment-marker');
  });

  it('discards the storage of a page that converts cleanly', async () => {
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({ results: [{ id: '1', title: 'Clean' }] }),
        jsonResponse(page('1', '<p>Body.</p>')),
      ]),
      'TT',
      { baseUrl: BASE_URL, limit: 50 },
    );

    expect(probe.ok && probe.value.pages[0]?.storage).toBeNull();
  });

  it('records a page it cannot read without aborting the run', async () => {
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({
          results: [
            { id: '1', title: 'Gone' },
            { id: '2', title: 'Fine' },
          ],
        }),
        jsonResponse({}, 403),
        jsonResponse(page('2', '<p>Body.</p>')),
      ]),
      'TT',
      { baseUrl: BASE_URL, limit: 50 },
    );

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.unreadable).toBe(1);
    expect(probe.value.certified).toBe(1);
  });

  it('classifies an unparseable body as unreadable', async () => {
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({ results: [{ id: '1', title: 'Broken' }] }),
        jsonResponse(page('1', '<p>unclosed')),
      ]),
      'TT',
      { baseUrl: BASE_URL, limit: 50 },
    );

    expect(probe.ok && probe.value.unreadable).toBe(1);
  });

  it('reports progress and can be cancelled', async () => {
    const seen: number[] = [];
    const probe = await probeSpaceFidelity(
      client([
        jsonResponse({
          results: [
            { id: '1', title: 'A' },
            { id: '2', title: 'B' },
          ],
        }),
      ]),
      'TT',
      {
        baseUrl: BASE_URL,
        limit: 50,
        onProgress: (done) => seen.push(done),
        isCancelled: () => true,
      },
    );

    expect(probe.ok && probe.value.sampled).toBe(0);
    expect(seen).toEqual([]);
  });

  it('propagates a failure to list pages', async () => {
    const probe = await probeSpaceFidelity(client([jsonResponse({}, 401)]), 'TT', {
      baseUrl: BASE_URL,
      limit: 50,
    });
    expect(probe.ok).toBe(false);
  });
});

describe('formatFidelityReport', () => {
  const base = {
    spaceKey: 'TT',
    sampled: 10,
    certified: 7,
    degraded: 3,
    unreadable: 0,
    pages: [],
    observations: {
      tableCellsWithParagraphs: 0,
      tableCellsBare: 0,
      withMacroId: 0,
      withLocalId: 0,
      withSchemaVersion: 0,
      withInlineComments: 0,
      withPageLinksMissingSpaceKey: 0,
    },
  };

  it('reports counts and shares', () => {
    const markdown = formatFidelityReport(base, BASE_URL);
    expect(markdown).toContain('Sampled **10** pages');
    expect(markdown).toContain('70%');
  });

  it('says the table question is unanswered when no tables were sampled', () => {
    expect(formatFidelityReport(base, BASE_URL)).toContain('still unanswered');
  });

  it('confirms bare cells match the converter', () => {
    const report = { ...base, observations: { ...base.observations, tableCellsBare: 5 } };
    expect(formatFidelityReport(report, BASE_URL)).toContain('No change needed');
  });

  it('warns clearly when cells are wrapped in paragraphs', () => {
    const report = { ...base, observations: { ...base.observations, tableCellsWithParagraphs: 5 } };
    const markdown = formatFidelityReport(report, BASE_URL);
    expect(markdown).toContain('read-only until the reverse pass is changed');
  });

  it('flags a mixed instance, where either choice leaves some pages read-only', () => {
    const report = {
      ...base,
      observations: { ...base.observations, tableCellsWithParagraphs: 3, tableCellsBare: 4 },
    };
    expect(formatFidelityReport(report, BASE_URL)).toContain('Both forms appear');
  });

  it('includes the storage of failing pages', () => {
    const report = {
      ...base,
      pages: [
        {
          id: '1',
          title: 'Broken',
          outcome: 'degraded' as const,
          detail: 'diverges',
          storage: '<p>evidence</p>',
        },
      ],
    };
    const markdown = formatFidelityReport(report, BASE_URL);
    expect(markdown).toContain('Broken (1) — degraded');
    expect(markdown).toContain('evidence');
  });

  it('says how many failing pages it omitted', () => {
    const failure = {
      id: 'x',
      title: 'T',
      outcome: 'degraded' as const,
      detail: null,
      storage: null,
    };
    const report = { ...base, pages: Array.from({ length: 12 }, () => failure) };
    expect(formatFidelityReport(report, BASE_URL)).toContain('4 further non-certified pages');
  });

  it('handles an empty sample without dividing by zero', () => {
    const report = { ...base, sampled: 0, certified: 0, degraded: 0 };
    expect(formatFidelityReport(report, BASE_URL)).toContain('—');
  });
});
