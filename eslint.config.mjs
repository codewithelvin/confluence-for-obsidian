import tseslint from 'typescript-eslint';

/**
 * Layer boundaries from the specification (§6.1). Dependencies point downward
 * only; these rules make a violation a build failure rather than a review note.
 */
const LAYER_MESSAGE =
  'Layer boundary violation (spec §6.1). Dependencies point downward only: UI -> Commands -> Orchestration -> Domain -> Gateways.';

const PURITY_MESSAGE =
  'Converters must be pure (spec §7.5): no I/O, no Obsidian API, no clock, no randomness. This is what makes them exhaustively testable.';

export default tseslint.config(
  {
    ignores: ['main.js', 'coverage/**', 'node_modules/**', 'dist/**'],
  },

  // Type-aware linting is scoped to TypeScript sources. Build scripts are plain
  // ESM outside the TS program, so applying type-checked rules to them fails.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `_`-prefixed names are deliberate discards, and rest-sibling
      // destructuring is the idiomatic way to omit a key.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // ---------------------------------------------------------------- baseline
  {
    files: ['src/**/*.ts'],
    rules: {
      // Spec §7.2 — strict typing
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],

      // Spec §7.3 — decomposition signals
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],

      // Spec §7.4 / §11.3 — Obsidian community-plugin review requirements.
      // Confluence page bodies are untrusted input; this is the XSS boundary.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message:
            'innerHTML is banned (spec §7.4). Confluence content is untrusted. Use createEl/createDiv/setText.',
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message: 'outerHTML is banned (spec §7.4). Use createEl/createDiv/setText.',
        },
        {
          selector: "MemberExpression[property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned (spec §7.4). Use createEl/createDiv/setText.',
        },
      ],

      // Spec §7.4 — never use the global `app`
      'no-restricted-globals': [
        'error',
        { name: 'app', message: 'Use this.app (spec §7.4). The global `app` is deprecated.' },
      ],

      // Spec §7.4 — no console outside the Logger
      'no-console': 'error',
    },
  },

  // ------------------------------------------------- converters must be pure
  {
    files: ['src/convert/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'obsidian', message: PURITY_MESSAGE }],
          patterns: [
            {
              group: ['**/api/**', '**/vault/**', '**/sync/**', '**/ui/**'],
              message: PURITY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // ----------------------------------------- gateways do not know about each
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/vault/**', '**/sync/**', '**/ui/**'], message: LAYER_MESSAGE }],
        },
      ],
    },
  },
  {
    files: ['src/vault/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/api/**', '**/sync/**', '**/ui/**'], message: LAYER_MESSAGE }] },
      ],
    },
  },

  // ------------------------------- only the API gateway may perform HTTP I/O
  {
    files: ['src/{convert,vault,sync,ui,settings,commands,util,auth}/**/*.ts', 'src/main.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'obsidian',
              importNames: ['requestUrl'],
              message:
                'All Confluence HTTP goes through ConfluenceClient in src/api/ (spec §6.1, hard rule).',
            },
          ],
        },
      ],
    },
  },

  // ------------------------------------------------------------- exemptions
  {
    // The Logger is the one place permitted to reach the console.
    files: ['src/util/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-console': 'off',
    },
  },
  {
    // Build and tooling scripts: core rules only, console permitted.
    files: ['**/*.mjs'],
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
);
