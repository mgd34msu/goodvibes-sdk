import { VoiceProviderRegistry } from './provider-registry.js';
import { createDeepgramProvider } from './providers/deepgram.js';
import { createElevenLabsProvider } from './providers/elevenlabs.js';
import { createGoogleProvider } from './providers/google.js';
import { createMicrosoftProvider } from './providers/microsoft.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createVydraProvider } from './providers/vydra.js';

export function ensureBuiltinVoiceProviders(registry: VoiceProviderRegistry): void {
  registry.register(createOpenAIProvider(), { replace: true });
  registry.register(createDeepgramProvider(), { replace: true });
  registry.register(createGoogleProvider(), { replace: true });
  registry.register(createElevenLabsProvider(), { replace: true });
  registry.register(createMicrosoftProvider(), { replace: true });
  registry.register(createVydraProvider(), { replace: true });
}
