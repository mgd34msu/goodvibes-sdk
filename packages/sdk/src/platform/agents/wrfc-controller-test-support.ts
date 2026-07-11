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
