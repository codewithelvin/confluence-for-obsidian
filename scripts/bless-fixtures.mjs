import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Regenerates `expected.md` and `fragments.json` for every golden fixture.
 *
 * Review the resulting diff before committing: blessing output that is wrong is
 * how a golden corpus stops being a test. The idempotence and certification
 * properties in corpus.test.ts hold independently of these files, so they remain
 * a real check even while expected output is being updated.
 *
 * Spawned rather than run as `BLESS_FIXTURES=1 vitest`, because that env-var
 * syntax is not valid in cmd.exe.
 */

const result = spawnSync('npx', ['vitest', 'run', 'tests/unit/corpus.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, BLESS_FIXTURES: '1' },
  shell: true,
});

process.exit(result.status ?? 1);
