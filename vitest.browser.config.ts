/**
 * Vitest browser configuration for Wave 2 real-browser runtime verification.
 *
 * Runs the test/browser/ harness against a headless Chromium context via
 * @vitest/browser + Playwright. Tests import the built dist/browser.js bundle
 * via the @pellux/goodvibes-sdk/browser subpath alias.
 *
 * Pre-requisite: `bun run build` must have produced packages/sdk/dist/browser.js
 * before this suite is launched.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Redirect @pellux/goodvibes-sdk/browser to the already-built dist file
      // so we exercise the real compiled output, not TS source.
      '@pellux/goodvibes-sdk/browser': resolve(
        __dirname,
        'packages/sdk/dist/browser.js',
      ),
    },
  },
  test: {
    name: 'browser',
    include: ['test/browser/**/*.test.ts'],
    setupFiles: ['test/browser/setup.ts'],
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
      headless: true,
    },
    // Do not inherit Bun globals; this suite runs in browser V8.
    globals: false,
    // Increase timeout for browser initialisation on slow CI runners.
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
