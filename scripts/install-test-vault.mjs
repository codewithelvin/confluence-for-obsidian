import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import process from 'node:process';

/**
 * Copies the built plugin into the local test vault.
 *
 * Run after `npm run build`, then use "Reload app without saving" in Obsidian
 * (Ctrl+P) to pick up the new bundle.
 */

const PLUGIN_ID = 'confluence-dc-connector';
const TARGET = `test-vault/.obsidian/plugins/${PLUGIN_ID}`;
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];

const missing = ARTIFACTS.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing build output: ${missing.join(', ')}. Run \`npm run build\` first.`);
  process.exit(1);
}

mkdirSync(TARGET, { recursive: true });
for (const file of ARTIFACTS) {
  copyFileSync(file, `${TARGET}/${file}`);
}

console.log(`Installed ${ARTIFACTS.length} files into ${TARGET}`);
console.log('Reload Obsidian ("Reload app without saving") to pick up the change.');
