/**
 * Vitest browser harness setup.
 *
 * Installs MSW (Mock Service Worker) request interception BEFORE any test
 * module executes. MSW v2 operates via setupWorker() in browser contexts,
 * intercepting fetch at the ServiceWorker level.
 *
 * The worker is started here with { onUnhandledRequest: 'error' } so that
 * any fetch not explicitly handled by a test fails loudly rather than
 * silently passing through (which would mask mis-mapped URLs).
 *
 * The exported `worker` is the shared MSW worker instance; individual test
 * files import it and call worker.use() to add per-test handlers.
 *
 * Pre-requisite: the MSW service worker file must exist at public/mockServiceWorker.js.
 * Generate it once with: npx msw init public/
 */
import { setupWorker } from 'msw/browser';
import { beforeAll, afterEach, afterAll } from 'vitest';

// The shared worker instance with no default handlers.
// Each test file registers its own handlers via worker.use().
export const worker = setupWorker();

// Start the worker before all tests.
beforeAll(async () => {
  await worker.start({ onUnhandledRequest: 'error', quiet: true });
});

// Reset handlers between tests to prevent handler pollution.
afterEach(() => {
  worker.resetHandlers();
});

// Stop the worker after all tests.
afterAll(() => {
  worker.stop();
});
