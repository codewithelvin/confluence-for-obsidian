import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

/**
 * Measures a synced mirror: layout, artefacts, and which constructs correlate
 * with a page being read-only.
 *
 * Written because every live pull this project has done was analysed with a dozen
 * ad-hoc `grep` commands, and the one that matters — the degradation *rate* per
 * construct — is the one that was easiest to skip. It is what found the last four
 * converter defects: a construct sitting far above the base rate names the
 * subsystem to probe, and probing candidate shapes through `certify` then names
 * the exact lines.
 *
 * Read-only. Never touches the vault it measures.
 *
 *   node scripts/survey-mirror.mjs <vault> [mount ...]
 */

const [vault, ...requested] = process.argv.slice(2);
if (vault === undefined) {
  console.error('usage: node scripts/survey-mirror.mjs <vault> [mount ...]');
  process.exit(1);
}

/**
 * Every Markdown file under a folder, with the attachment folders excluded.
 *
 * A folder that is not there yields nothing rather than throwing: a mount may
 * simply not have synced yet, and a measuring tool that dies on one absent mount
 * cannot report on the others.
 */
function notesUnder(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '_attachments' && !entry.name.startsWith('.')) walk(path);
      } else if (entry.name.endsWith('.md')) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}

function attachmentStats(mountPath) {
  const root = join(mountPath, '_attachments');
  let count = 0;
  let bytes = 0;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        count += 1;
        bytes += statSync(path).size;
      }
    }
  };
  try {
    walk(root);
  } catch {
    // No attachments folder: nothing downloaded for this mount.
  }
  return { count, bytes };
}

/**
 * Constructs worth correlating. Each is a plain substring, because a note either
 * contains one or does not — the rate across notes is the signal, not the count.
 */
const CONSTRUCTS = [
  ['![[', 'image embed'],
  ['[[', 'wikilink'],
  ['<table', 'html table'],
  ['| ---', 'GFM table'],
  ['{cf:', 'placeholder'],
  ['<span style', 'inline span'],
  ['<br/>', 'raw break'],
  ['&#x20;', 'encoded space'],
  ['&#x200B;', 'zero-width space'],
  ['> [!', 'callout'],
  ['```', 'code fence'],
  ['<!--cf-th-->', 'row-header table'],
  ['aliases:', 'title alias'],
];

const mounts = requested.length > 0 ? requested : ['.'];
const notes = [];

for (const mount of mounts) {
  const root = join(vault, mount);
  for (const path of notesUnder(root)) {
    notes.push({ path, mount, text: readFileSync(path, 'utf8') });
  }
}

if (notes.length === 0) {
  console.error(`no notes found under ${vault}`);
  process.exit(1);
}

const degraded = notes.filter((note) => note.text.includes('fidelity: degraded'));
const baseRate = (degraded.length / notes.length) * 100;

console.log(`\n=== ${vault}  (${mounts.join(', ')})`);
console.log(`notes                 ${notes.length}`);
console.log(
  `certified             ${notes.length - degraded.length}  (${(100 - baseRate).toFixed(1)}%)`,
);
console.log(`degraded              ${degraded.length}  (${baseRate.toFixed(1)}%)  <- base rate\n`);

for (const mount of mounts) {
  const own = notes.filter((note) => note.mount === mount);
  if (own.length === 0) continue;

  const depths = own.map((note) => relative(vault, note.path).split(/[\\/]/).length);
  const truncated = own.filter((note) => /~\d{6}\.md$/.test(note.path));
  const { count, bytes } = attachmentStats(join(vault, mount));

  console.log(`  ${mount}: ${own.length} notes, depth ${Math.max(...depths)}`);
  console.log(`    truncated names   ${truncated.length}`);
  console.log(`    attachments       ${count}  (${(bytes / 1_048_576).toFixed(0)} MB)`);
}

console.log('\nconstruct               notes  degraded   rate   vs base');
for (const [needle, label] of CONSTRUCTS) {
  const holding = notes.filter((note) => note.text.includes(needle));
  if (holding.length === 0) continue;

  const bad = holding.filter((note) => note.text.includes('fidelity: degraded')).length;
  const rate = (bad / holding.length) * 100;
  // A construct far above the base rate is the one to probe; well below it is
  // evidence the construct is handled properly rather than merely present.
  const delta = rate - baseRate;
  const flag = delta > 20 ? '  <== SUSPECT' : '';
  console.log(
    `${label.padEnd(22)} ${String(holding.length).padStart(5)}` +
      `  ${String(bad).padStart(8)}  ${rate.toFixed(0).padStart(4)}%  ` +
      `${delta > 0 ? '+' : ''}${delta.toFixed(0).padStart(4)}pp${flag}`,
  );
}

const totals = new Map();
for (const [needle, label] of CONSTRUCTS) {
  const n = notes.reduce((sum, note) => sum + note.text.split(needle).length - 1, 0);
  if (n > 0) totals.set(label, n);
}
console.log('\ntotal occurrences');
for (const [label, n] of [...totals].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label.padEnd(22)} ${n}`);
}
console.log();
