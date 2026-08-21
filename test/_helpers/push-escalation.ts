/**
 * A cancellable escalation scheduler for tests that build a `PushService`.
 *
 * `PushService` arms a one-shot escalation timer for every block it starts
 * tracking, and it has no teardown of its own, the daemon that owns one lives
 * for the life of the process, so nothing ever needed to cancel them. A test
 * that hand-builds a service and drives a handful of notices through it
 * therefore leaves one pending timer per notice, live for the rest of the run.
 *
 * This keeps the default scheduler's semantics EXACTLY (a real `setTimeout`,
 * `unref`'d, returning a cancel handle) and only remembers the handle, so the
 * timers a test armed are cancelled when that test ends. Escalation timing is
 * unchanged, so a test that actually exercises escalation still does.
 */
import type { DisposableRegistry } from './disposables.ts';

/** Matches `EscalationScheduler` in platform/push/service.ts. */
export interface CancellableScheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

export function cancellableEscalationScheduler(
  disposables: DisposableRegistry,
): CancellableScheduler {
  return {
    schedule(fn, delayMs) {
      const handle = setTimeout(fn, delayMs);
      // Node/Bun: don't hold the event loop open for a pending reminder.
      (handle as unknown as { unref?: () => void }).unref?.();
      const cancel = (): void => clearTimeout(handle);
      disposables.defer(cancel);
      return cancel;
    },
  };
}
