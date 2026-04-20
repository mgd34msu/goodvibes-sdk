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
import { beforeAll, afterEach, afterAll } from 'vitest';

/**
 * Guards against running MSW setup in non-browser environments (Node/Bun test
 * runner). The browser tests are designed for vitest + Playwright and must
 * only execute in a real browser V8 context where `window` is defined.
 *
 * When running under `bun test` (which lacks a browser context), all MSW
 * lifecycle hooks become no-ops so bun can discover the files without failing
 * at import time. The individual test suites skip via `describe.skipIf`.
 */
const IS_BROWSER = typeof window !== 'undefined';

type WorkerLike = {
  use: (...handlers: unknown[]) => void;
  resetHandlers: () => void;
  start: (options?: unknown) => Promise<void>;
  stop: () => void;
};

let worker: WorkerLike;

if (IS_BROWSER) {
  // Dynamic import avoids calling setupWorker() at module parse time in non-browser envs.
  const { setupWorker } = await import('msw/browser');
  worker = setupWorker();

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
} else {
  // No-op stub so test files that import { worker } compile and load without errors.
  worker = {
    use: () => {},
    resetHandlers: () => {},
    start: async () => {},
    stop: () => {},
  };
}

export { worker };
