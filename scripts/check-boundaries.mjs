import { ESLint } from 'eslint';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Proves the architecture rules actually reject violations.
 *
 * The spec says layer violations are a build failure (§6.1, §7.4), but an
 * ESLint config can silently stop enforcing a rule — flat-config entries
 * replace rather than merge, so an overlapping later block can wipe an earlier
 * one. That happened once and was invisible until probed. This script writes
 * deliberately-illegal files, lints them, and fails if any is accepted.
 */

const PROBES = [
  {
    label: 'convert must not import the Obsidian API',
    path: 'src/convert/__boundary_probe.ts',
    code: "import { Notice } from 'obsidian';\nexport const probe = Notice;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'convert must not import the API gateway',
    path: 'src/convert/__boundary_probe_api.ts',
    code: "import { ObsidianTransport } from '../api/http-transport';\nexport const probe = ObsidianTransport;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'vault must not import the API gateway',
    path: 'src/vault/__boundary_probe.ts',
    code: "import { ObsidianTransport } from '../api/http-transport';\nexport const probe = ObsidianTransport;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'api must not import the UI layer',
    path: 'src/api/__boundary_probe.ts',
    code: "import { ConfirmModal } from '../ui/confirm-modal';\nexport const probe = ConfirmModal;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'only the API gateway may perform HTTP',
    path: 'src/sync/__boundary_probe.ts',
    code: "import { requestUrl } from 'obsidian';\nexport const probe = requestUrl;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'the sync engine must not depend on the host application',
    path: 'src/sync/__boundary_probe_host.ts',
    code: "import { Notice } from 'obsidian';\nexport const probe = Notice;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'the sync engine must not import the UI layer',
    path: 'src/sync/__boundary_probe_ui.ts',
    code: "import { ConfirmModal } from '../ui/confirm-modal';\nexport const probe = ConfirmModal;\n",
    rule: 'no-restricted-imports',
  },
  {
    label: 'innerHTML is banned everywhere (XSS boundary)',
    path: 'src/ui/__boundary_probe.ts',
    code: 'export function probe(el: HTMLElement): void {\n  el.innerHTML = "<b>x</b>";\n}\n',
    rule: 'no-restricted-syntax',
  },
];

const createdDirs = new Set();
const createdFiles = [];

function writeProbe(probe) {
  const dir = probe.path.slice(0, probe.path.lastIndexOf('/'));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    createdDirs.add(dir);
  }
  writeFileSync(probe.path, probe.code);
  createdFiles.push(probe.path);
}

function cleanUp() {
  for (const file of createdFiles) rmSync(file, { force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}

let failures = 0;

try {
  for (const probe of PROBES) writeProbe(probe);

  const eslint = new ESLint({ cwd: process.cwd() });

  for (const probe of PROBES) {
    const [result] = await eslint.lintFiles([probe.path]);
    const caught = (result?.messages ?? []).some((message) => message.ruleId === probe.rule);

    if (caught) {
      console.log(`  ok    ${probe.label}`);
    } else {
      failures += 1;
      console.error(`  FAIL  ${probe.label} — expected rule "${probe.rule}" to reject it`);
    }
  }
} finally {
  cleanUp();
}

if (failures > 0) {
  console.error(`\n${failures} architecture rule(s) are not being enforced.`);
  process.exit(1);
}

console.log(`\nAll ${PROBES.length} architecture boundaries are enforced.`);
