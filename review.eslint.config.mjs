import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

/**
 * The community-directory review's own rule set, run locally.
 *
 * Four releases went to the directory's automated gate before anyone ran this,
 * and every one of the 21 errors it reported would have shown up here first.
 * It is deliberately NOT part of `npm run verify`: `eslint-plugin-obsidianmd`
 * pins `obsidian@1.8.7` as a peer dependency, which would break `npm ci`.
 *
 *   npm i eslint-plugin-obsidianmd@0.4.1 --no-save --no-package-lock --legacy-peer-deps
 *   npm run lint:review
 *
 * Two things this config exists to get right:
 *
 * - `projectService`, or every type-aware rule throws instead of reporting.
 * - The run is scoped to `src/` by the script, because that is what the review
 *   reads. Pointed at the repo root it also lints `tests/` and the config
 *   files, which sit outside the TS program and produce hundreds of parse
 *   errors that look like findings and are not.
 *
 * Warnings are evidence, not instructions. Several standing ones are answered
 * deliberately — see spec §11.3 and decision D28.
 */
export default tseslint.config(
  {
    ignores: ['main.js', 'coverage/**', 'node_modules/**', 'dist/**', 'version-bump.mjs'],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
