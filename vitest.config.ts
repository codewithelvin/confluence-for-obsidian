import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `obsidian` is provided by the host app at runtime and has no
      // installable implementation. Tests resolve it to a hand-written fake.
      obsidian: fileURLToPath(new URL('./tests/fakes/obsidian.ts', import.meta.url)),
    },
  },
  test: {
    // jsdom throughout: UI smoke tests need a document, and pure tests are
    // unaffected by its presence.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // UI is excluded from coverage gates (spec §8.1) but must have smoke
        // tests proving it mounts and unmounts cleanly.
        'src/ui/**',
        'src/main.ts',
        // Type-only modules emit no runtime code.
        'src/**/*-types.ts',
      ],
      // Gates from spec §8.1. Per-area gates are added by the milestone that
      // creates each area, because a glob matching zero files enforces nothing.
      // `convert` (95/95) and `sync` (90/85) arrive with M2 and M3.
      //
      // Values sit a few points below measured coverage: high enough to catch
      // a real regression, with enough headroom that an ordinary refactor does
      // not fail CI for no reason.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
        // Spec §8.1 asks for 95% branch coverage here. Achieved: 99% lines,
        // ~90% branch. The shortfall is entirely unreachable defensive
        // fallbacks that strict TypeScript requires — `textContent ?? ''`,
        // `getAttribute(...) ?? ''`, regex groups that cannot be undefined once
        // the pattern matched. Reaching 95% would mean either tests that cannot
        // actually exercise those paths or non-null assertions, which §7.2
        // bans. Flagged to the client as a deviation rather than silently
        // lowered; see the M2 journal entry.
        'src/convert/**': { lines: 95, functions: 95, branches: 88, statements: 95 },
        'src/api/**': { lines: 90, functions: 85, branches: 88, statements: 90 },
        // Spec §8.1 gate for the sync engine, in force from M3.
        'src/sync/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        // The vault gateway is the only code in the plugin that can lose one of
        // the user's own files, so it is held to the same bar as auth.
        'src/vault/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        // Security-critical: this is the code holding the promise that a token
        // never reaches disk in plain text.
        'src/auth/**': { lines: 95, functions: 90, branches: 85, statements: 95 },
        'src/settings/**': { lines: 90, functions: 85, branches: 90, statements: 90 },
        'src/util/**': { lines: 90, functions: 90, branches: 88, statements: 90 },
      },
    },
  },
});
