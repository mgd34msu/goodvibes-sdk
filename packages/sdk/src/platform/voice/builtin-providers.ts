import { VoiceProviderRegistry } from './provider-registry.js';
import { createDeepgramProvider } from './providers/deepgram.js';
import { createElevenLabsProvider } from './providers/elevenlabs.js';
import { createGoogleProvider } from './providers/google.js';
import { createMicrosoftProvider } from './providers/microsoft.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createVydraProvider } from './providers/vydra.js';
import { createLocalVoiceProvider, type LocalVoiceConfigReader } from './providers/local.js';
import { resolveManagedEngine } from './provisioning/provisioner.js';

export interface BuiltinVoiceProviderOptions {
  /** voice.local.* config reader — registers the free local-engine provider when present. */
  readonly readConfig?: LocalVoiceConfigReader | undefined;
  /**
   * The managed voice-runtime root. When set, a provisioned host resolves engine
   * binaries/models from the managed install by default (config still wins), so
   * local voice works with zero further configuration.
   */
  readonly managedVoiceRoot?: string | undefined;
}

export function ensureBuiltinVoiceProviders(registry: VoiceProviderRegistry, options: BuiltinVoiceProviderOptions = {}): void {
  registry.register(createOpenAIProvider(), { replace: true });
  registry.register(createDeepgramProvider(), { replace: true });
  registry.register(createGoogleProvider(), { replace: true });
  registry.register(createElevenLabsProvider(), { replace: true });
  registry.register(createMicrosoftProvider(), { replace: true });
  registry.register(createVydraProvider(), { replace: true });
  // The free local peer beside the cloud routes — same seams, honest
  // 'unconfigured' until the user completes the one explicit setup action.
  if (options.readConfig) {
    const managedRoot = options.managedVoiceRoot;
    registry.register(createLocalVoiceProvider({
      readConfig: options.readConfig,
      ...(managedRoot ? { resolveManaged: (prefix) => resolveManagedEngine(prefix, managedRoot) } : {}),
    }), { replace: true });
  }
}
