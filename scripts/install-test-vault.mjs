import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Copies the built plugin into the local test vault.
 *
 * Run after `npm run build`, then use "Reload app without saving" in Obsidian
 * (Ctrl+P) to pick up the new bundle.
 *
 * The vault lives outside the repo on some machines, so the target is
 * resolved rather than hard-coded: `TEST_VAULT_PATH`, then a git-ignored
 * `.test-vault-path.local` file, then `test-vault/` beside the sources. An
 * absolute path in the repo would be wrong for every other developer.
 */

const PLUGIN_ID = 'confluence-dc-connector';
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];
const POINTER_FILE = '.test-vault-path.local';

function resolveVault() {
  const fromEnv = process.env.TEST_VAULT_PATH?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return { path: fromEnv, source: 'TEST_VAULT_PATH' };

  if (existsSync(POINTER_FILE)) {
    const fromFile = readFileSync(POINTER_FILE, 'utf8').trim();
    if (fromFile !== '') return { path: fromFile, source: POINTER_FILE };
  }

  return { path: 'test-vault', source: 'default' };
}

const vault = resolveVault();
if (!existsSync(vault.path)) {
  console.error(`Test vault not found at ${vault.path} (from ${vault.source}).`);
  process.exit(1);
}

const missing = ARTIFACTS.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing build output: ${missing.join(', ')}. Run \`npm run build\` first.`);
  process.exit(1);
}

const target = path.join(vault.path, '.obsidian', 'plugins', PLUGIN_ID);
mkdirSync(target, { recursive: true });
for (const file of ARTIFACTS) {
  copyFileSync(file, path.join(target, file));
}

console.log(`Installed ${ARTIFACTS.length} files into ${target} (vault from ${vault.source})`);
console.log('Reload Obsidian ("Reload app without saving") to pick up the change.');
