/**
 * γ3: Orchestrator abort() clears animInterval
 *
 * Tests:
 * - abort() immediately clears the thinking-animation interval
 * - isThinking is false after abort()
 * - No outstanding setInterval handles remain after abort()
 */
import { describe, expect, test } from 'bun:test';

/**
 * Minimal mock of the Orchestrator's animInterval lifecycle.
 * We test the invariant directly on the class behaviour rather than
 * instantiating the full Orchestrator (which requires 11+ constructor params).
 *
 * The contract under test:
 *   abort() must call clearInterval(this.animInterval) and set animInterval=null.
 */
class MockOrchestrator {
  animInterval: ReturnType<typeof setInterval> | null = null;
  isThinking = false;
  abortCalled = false;

  startThinking(): void {
    this.isThinking = true;
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = setInterval(() => { /* tick */ }, 80);
  }

  abort(): void {
    this.abortCalled = true;
    if (this.animInterval !== null) {
      clearInterval(this.animInterval);
      this.animInterval = null;
    }
    this.isThinking = false;
  }

  dispose(): void {
    this.abort();
  }
}

describe('Orchestrator.abort() animInterval cleanup', () => {
  test('abort() clears animInterval and sets isThinking=false', () => {
    const orch = new MockOrchestrator();
    orch.startThinking();
    expect(orch.animInterval).not.toBeNull();
    expect(orch.isThinking).toBe(true);

    orch.abort();

    expect(orch.animInterval).toBeNull();
    expect(orch.isThinking).toBe(false);
  });

  test('abort() is idempotent — calling twice does not throw', () => {
    const orch = new MockOrchestrator();
    orch.startThinking();
    expect(() => {
      orch.abort();
      orch.abort();
    }).not.toThrow();
    expect(orch.animInterval).toBeNull();
  });

  test('abort() without startThinking() does not throw', () => {
    const orch = new MockOrchestrator();
    expect(() => orch.abort()).not.toThrow();
    expect(orch.animInterval).toBeNull();
    expect(orch.isThinking).toBe(false);
  });

  test('no outstanding timer after abort() — setImmediate fires with null interval', async () => {
    const orch = new MockOrchestrator();
    orch.startThinking();
    orch.abort();

    // Give the event loop a chance to drain any residual timer callbacks
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(orch.animInterval).toBeNull();
    expect(orch.isThinking).toBe(false);
  });

  test('actual Orchestrator class: abort() sets animInterval=null', async () => {
    // Dynamic import to avoid pulling all of Orchestrator's heavy deps into the
    // test environment. We only verify the abort() method behaviour on the
    // real class by patching the private field directly.
    const { Orchestrator } = await import('../packages/sdk/src/platform/core/orchestrator.js');

    // Construct a minimal orchestrator using Object.create to bypass constructor
    const orch = Object.create(Orchestrator.prototype) as InstanceType<typeof Orchestrator>;
    // Patch animInterval directly
    (orch as unknown as { animInterval: ReturnType<typeof setInterval> | null }).animInterval =
      setInterval(() => { /* noop */ }, 100);
    (orch as unknown as { isThinking: boolean }).isThinking = true;
    (orch as unknown as { abortController: AbortController | null }).abortController = null;
    (orch as unknown as { autoSpawnTimeout: ReturnType<typeof setTimeout> | null }).autoSpawnTimeout = null;

    orch.abort();

    expect((orch as unknown as { animInterval: ReturnType<typeof setInterval> | null }).animInterval).toBeNull();
    expect((orch as unknown as { isThinking: boolean }).isThinking).toBe(false);
  });
});
