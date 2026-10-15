import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      // Scoped to the engine on purpose. Pages are DOM builders; the few page
      // tests (tests/page-*.test.js) run in jsdom against a stubbed app.js and
      // assert on writes, so a whole-repo number would still be dominated by
      // code this suite does not reach and would say nothing about a change.
      // The engine is where the money math lives and where a drop matters.
      include: ['js/engine/**/*.js'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      // Set a few points under the current figures: high enough that
      // deleting a suite or landing a large untested branch trips it, loose
      // enough that ordinary work does not.
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 92,
        lines: 95,
      },
    },
  },
});
