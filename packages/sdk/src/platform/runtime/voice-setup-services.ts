// ---------------------------------------------------------------------------
// voice-setup-services.ts, managed local-voice provisioning composition.
//
// Backs the daemon's voice.local.status / voice.local.install verbs. The
// provisioning policy, a single-flight one-act install that provisions the
// piper engine + a default voice (and whisper STT where a bundle is published),
// live install-progress folded onto status(), ownership-aware preconfigure of
// the voice.local.* keys (values THIS installer previously wrote update to the
// new managed paths; genuinely user-set values still win; a user-cleared
// installer value stays cleared), a no-network status() read, and critical-tier
// admission gating, lives in the SDK's createVoiceSetupService. Earlier the
// composer was not exported, so the TUI rebuilt it from the voice primitives;
// SDK 1.10.1 exports it through ./platform/runtime/voice-setup, so this module
// is now a thin adapter that maps the TUI's injected seams (configManager,
// shellPaths, voiceProviders) onto the SDK service's flat deps.
//
// Extracted into its own module rather than built inline in services.ts, which
// sits at the architecture check's 800-line cap (scripts/check-architecture.ts)
//, new service construction gets its own module and a single wiring call there.
// ---------------------------------------------------------------------------

import {
  createVoiceSetupService,
  type VoiceSetupService,
} from './voice-setup.js';
import {
  startWakeBootProvisioning,
  type VoiceProviderRegistry,
} from '../voice/index.js';
import type { ConfigManager } from '../config/index.js';
import { logger } from '../utils/index.js';
import type { ShellPathService } from './shell-paths.js';

export type { VoiceSetupService };

/**
 * The recovery act this surface names when a boot provision degrades.
 *
 * Phrased as something the PLATFORM does. It used to be the literal string
 * `/voice wake setup`, a command handed to the user for work the daemon
 * already retries on its own at every start. Naming a chore that the product
 * performs unprompted is how a self-healing system reads as a broken one.
 */
export const WAKE_RECOVERY_COMMAND = 'this surface fetches it automatically when it next starts';

export interface VoiceSetupServicesDeps {
  readonly configManager: ConfigManager;
  readonly shellPaths: Pick<ShellPathService, 'resolveUserPath'>;
  readonly voiceProviders: VoiceProviderRegistry;
  /** Critical-tier admission gate, a provision run allocates archive + model buffers. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
  /**
   * Opt into boot-time wake-model provisioning and the recovery sweeper.
   *
   * Off unless a real entrypoint asks for it, matching how this graph treats the
   * host power seam: `daemon/cli.ts` and `runtime/bootstrap-core.ts` opt in, the
   * one-shot CLI commands do not, and a test composing the graph gets neither a
   * network fetch nor a repeating timer it did not ask for.
   */
  readonly provisionWakeModelsAtBoot?: boolean | undefined;
  /** Injected in tests: the boot starter, so no sweeper and no fetch are real. */
  readonly startBootProvisioning?: typeof startWakeBootProvisioning | undefined;
}

export interface VoiceSetupServices {
  readonly voiceSetup: VoiceSetupService;
  /**
   * Stop the wake-word recovery sweeper and cancel a pending boot provision.
   * A no-op when boot provisioning was not opted into. Registered on the
   * disposal scope (disposal-wiring.ts), an hourly timer nothing stops is a
   * poller this surface leaked, which is exactly what that scope exists for.
   */
  readonly stopWakeHousekeeping: () => void;
}

/** Compose the managed-voice single-flight install + no-network status read. */
export function wireVoiceSetup(deps: VoiceSetupServicesDeps): VoiceSetupServices {
  const { configManager, voiceProviders } = deps;
  const managedVoiceRoot = deps.shellPaths.resolveUserPath('voice');
  const voiceSetup = createVoiceSetupService({
    managedVoiceRoot,
    getConfig: (key) => String(configManager.get(key as Parameters<typeof configManager.get>[0]) ?? ''),
    setConfig: (key, value) => configManager.setDynamic(key as Parameters<typeof configManager.setDynamic>[0], value),
    // A successful (re-)install clears any tripped local-engine breaker.
    resetLocalEngineFailureState: () => voiceProviders.get('local')?.resetEngineFailureState?.(),
    admitExpensiveWork: deps.admitExpensiveWork,
  });
  if (deps.provisionWakeModelsAtBoot !== true) {
    return { voiceSetup, stopWakeHousekeeping: () => {} };
  }
  // Sweep the wake tree, then fetch whatever the install could not. The SDK owns
  // the policy, never throws, one plain message, reaps before it retries, and
  // routes the attempt through the setup service's single flight so a boot
  // attempt and an explicitly requested provision are one download.
  const boot = (deps.startBootProvisioning ?? startWakeBootProvisioning)({
    managedRoot: managedVoiceRoot,
    ensureProvisioned: () => voiceSetup.wakeEnsureProvisioned({ recoveryHint: WAKE_RECOVERY_COMMAND }),
    announce: (message) => { logger.info(message); },
  });
  return { voiceSetup, stopWakeHousekeeping: () => boot.stop() };
}
