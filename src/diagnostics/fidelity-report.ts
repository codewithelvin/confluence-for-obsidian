import type { FidelityReport, FormatObservations } from './fidelity-probe';

/**
 * Renders a probe result as Markdown, for copying out of the plugin.
 *
 * Pure, so the wording and the conclusions it draws are testable.
 */

/** Degraded pages included with their storage excerpt. */
const MAX_DETAILED = 8;

const OBSERVATION_LABELS: Record<keyof FormatObservations, string> = {
  tableCellsWithParagraphs: 'Table cells wrapping content in `<p>`',
  tableCellsBare: 'Table cells holding content directly',
  withMacroId: 'Pages carrying `ac:macro-id`',
  withLocalId: 'Pages carrying `ac:local-id`',
  withSchemaVersion: 'Pages carrying `ac:schema-version`',
  withInlineComments: 'Pages with inline comment markers',
  withPageLinksMissingSpaceKey: 'Pages with `ri:page` links omitting `ri:space-key`',
};

function percentage(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${String(Math.round((part / whole) * 100))}%`;
}

/**
 * The headline finding: which table-cell form this instance uses.
 *
 * The converter writes bare cells. If this instance wraps them in `<p>`, every
 * table-bearing page is read-only until the reverse pass is changed to match —
 * which is a one-line change, but only if we know to make it.
 */
function tableCellVerdict(observations: FormatObservations): string {
  const wrapped = observations.tableCellsWithParagraphs;
  const bare = observations.tableCellsBare;

  if (wrapped === 0 && bare === 0) return 'No tables were sampled, so this is still unanswered.';
  if (wrapped === 0)
    return 'Bare cells only — matches what the converter writes. No change needed.';
  if (bare === 0) {
    return (
      'Cells are wrapped in `<p>` — the converter writes bare cells, so every table page is ' +
      'read-only until the reverse pass is changed to emit `<p>` inside cells.'
    );
  }
  return (
    `Both forms appear (${String(wrapped)} wrapped, ${String(bare)} bare). The reverse pass can ` +
    'only produce one, so whichever is rarer will stay read-only unless the form is recorded per page.'
  );
}

export function formatFidelityReport(report: FidelityReport, baseUrl: string): string {
  const lines: string[] = [
    `# Confluence conversion fidelity — space ${report.spaceKey}`,
    '',
    `Sampled **${String(report.sampled)}** pages from ${baseUrl}.`,
    '',
    '| Outcome | Pages | Share |',
    '| --- | ---: | ---: |',
    `| Certified — safe to edit and push | ${String(report.certified)} | ${percentage(report.certified, report.sampled)} |`,
    `| Degraded — readable, read-only | ${String(report.degraded)} | ${percentage(report.degraded, report.sampled)} |`,
    `| Unreadable — could not be parsed | ${String(report.unreadable)} | ${percentage(report.unreadable, report.sampled)} |`,
    '',
    '## Format observations',
    '',
    '| Trait | Pages |',
    '| --- | ---: |',
  ];

  for (const [key, label] of Object.entries(OBSERVATION_LABELS)) {
    const count = report.observations[key as keyof FormatObservations];
    lines.push(`| ${label} | ${String(count)} |`);
  }

  lines.push('', '### Table cell form', '', tableCellVerdict(report.observations), '');

  const failures = report.pages.filter((page) => page.outcome !== 'certified');
  if (failures.length > 0) {
    lines.push('## Pages that are not editable', '');

    for (const page of failures.slice(0, MAX_DETAILED)) {
      lines.push(`### ${page.title} (${page.id}) — ${page.outcome}`, '');
      if (page.detail !== null) lines.push('```', page.detail, '```', '');
      if (page.storage !== null) {
        lines.push(
          '<details><summary>Storage format</summary>',
          '',
          '```xml',
          page.storage,
          '```',
          '',
          '</details>',
          '',
        );
      }
    }

    if (failures.length > MAX_DETAILED) {
      lines.push(
        `_${String(failures.length - MAX_DETAILED)} further non-certified pages omitted._`,
        '',
      );
    }
  }

  return lines.join('\n');
}
