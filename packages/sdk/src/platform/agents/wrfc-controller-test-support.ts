/**
 * wrfc-controller-test-support.ts
 *
 * Test-only construction seam for WrfcController. `skipClaimVerification`
 * disables the phantom-work guard (verifyEngineerClaims) and must NEVER be set
 * by production code, so it is not a public constructor option. This factory is
 * the sole sanctioned path that injects it — named `…ForTest` per the repo's
 * test-seam idiom (cf. `buildFromFilesForTest`, `resolveSpecifierForTest`).
 * Production code calls `new WrfcController(...)` directly and never reaches here.
 */
import type { AgentMessageBus } from './message-bus.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { WrfcController } from './wrfc-controller.js';

/**
 * Construct a WrfcController with test-only affordances. The `skipClaimVerification`
 * flag rides the internal seam the constructor reads via a narrow cast; every
 * other field is the ordinary public constructor deps.
 */
export function createWrfcControllerForTest(
  runtimeBus: RuntimeEventBus,
  messageBus: Pick<AgentMessageBus, 'registerAgent'>,
  deps: ConstructorParameters<typeof WrfcController>[2] & { readonly skipClaimVerification?: boolean },
): WrfcController {
  return new WrfcController(runtimeBus, messageBus, deps);
}

/** One recorded planned-fix invocation the stub runner saw. */
export interface StubFixRunInput {
  readonly chainId: string;
  readonly originalTask: string;
  readonly review: import('./completion-report.js').ReviewerReport;
  readonly attempt: number;
}

/**
 * Install a scripted FixWorkstreamRunner on a controller under test (the
 * planned-fix path that replaced the single-fixer prompt). Behaviors:
 * - 'merged' (default): every cycle resolves merged — the controller proceeds
 *   to the terminal contract re-review (a fresh reviewer spawn the harness
 *   can complete);
 * - 'failed': every cycle resolves a structured tasks-failed outcome;
 * - 'pending': the promise never settles — the chain stays honestly 'fixing'.
 * Returns the recorded invocations for assertions.
 */
export function installStubFixRunner(
  controller: WrfcController,
  behavior: 'merged' | 'failed' | 'pending' = 'merged',
): StubFixRunInput[] {
  const runs: StubFixRunInput[] = [];
  controller.setFixWorkstreamRunner({
    run(input) {
      runs.push({ chainId: input.chainId, originalTask: input.originalTask, review: input.review, attempt: input.attempt });
      if (behavior === 'pending') return new Promise(() => { /* never settles */ });
      if (behavior === 'failed') {
        return Promise.resolve({ status: 'failed' as const, reason: 'stub: fix tasks failed', structured: 'tasks-failed' as const });
      }
      return Promise.resolve({
        status: 'merged' as const,
        workstreamId: `ws-stub-${runs.length}`,
        taskCount: (input.review.issues ?? []).length || 1,
        mergedTitles: (input.review.issues ?? []).map((issue) => issue.description).slice(0, 5),
        filesModified: (input.review.issues ?? []).flatMap((issue) => (issue.file ? [issue.file] : [])),
      });
    },
  });
  return runs;
}
