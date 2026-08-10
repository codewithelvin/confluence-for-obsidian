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
      // Overall gates from spec §8.1. Per-area gates (convert 95%, sync 90%,
      // vault 90%, api 85%) are added in the milestone that creates each area,
      // because a glob matching zero files cannot be meaningfully enforced.
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
