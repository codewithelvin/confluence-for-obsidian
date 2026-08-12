import esbuild from 'esbuild';
import process from 'node:process';

const isProduction = process.argv[2] === 'production';

const banner = `/*
 * Confluence DC Connector
 * https://github.com/codewithelvin/confluence-for-obsidian
 * This is a generated bundle. Source lives in src/.
 */`;

/**
 * Modules Obsidian provides at runtime, plus everything CodeMirror ships with
 * the app. Bundling any of these would produce a broken or bloated plugin.
 */
const external = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  'node:fs',
  'node:path',
  'node:crypto',
  'node:os',
];

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: isProduction ? false : 'inline',
  treeShaking: true,
  minify: isProduction,
  outfile: 'main.js',
  banner: { js: banner },
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
