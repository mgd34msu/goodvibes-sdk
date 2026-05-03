import { VoiceProviderRegistry } from './provider-registry.js';
import { DaemonErrorCategory, GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type {
  VoiceDescriptor,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceSynthesisStreamResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from './types.js';

export interface VoiceServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: Awaited<ReturnType<VoiceProviderRegistry['status']>>;
  readonly note: string;
}

export class VoiceService {
  constructor(private readonly registry: VoiceProviderRegistry) {}

  async getStatus(enabled: boolean): Promise<VoiceServiceStatus> {
    const providers = await this.registry.status();
    return {
      enabled,
      providerCount: providers.length,
      providers,
      note: 'Voice capture is intentionally external to the SDK host process; terminal, web, or companion clients can stream audio into these provider-backed APIs.',
    };
  }

  async listVoices(providerId?: string): Promise<readonly VoiceDescriptor[]> {
    const providers = providerId
      ? [this.registry.get(providerId)].filter((provider): provider is NonNullable<typeof provider> => provider !== null)
      : this.registry.list().map((entry) => this.registry.get(entry.id)).filter((provider): provider is NonNullable<typeof provider> => provider !== null);
    const voices: VoiceDescriptor[] = [];
    for (const provider of providers) {
      if (!provider.listVoices) continue;
      voices.push(...await provider.listVoices());
    }
    return voices.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async synthesize(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const provider = this.registry.findProvider('tts', providerId);
    if (!provider?.synthesize) {
      throw providerNotConfiguredError(providerId, 'Voice TTS provider');
    }
    return provider.synthesize(request);
  }

  async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
    const provider = this.registry.findProvider('tts-stream', providerId);
    if (!provider?.synthesizeStream) {
      throw providerNotConfiguredError(providerId, 'Voice streaming TTS provider');
    }
    return provider.synthesizeStream(request);
  }

  async transcribe(providerId: string | undefined, request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const provider = this.registry.findProvider('stt', providerId);
    if (!provider?.transcribe) {
      throw providerNotConfiguredError(providerId, 'Voice STT provider');
    }
    return provider.transcribe(request);
  }

  async openRealtimeSession(providerId: string | undefined, request: VoiceRealtimeSessionRequest): Promise<VoiceRealtimeSession> {
    const provider = this.registry.findProvider('realtime', providerId);
    if (!provider?.openRealtimeSession) {
      throw providerNotConfiguredError(providerId, 'Voice realtime provider');
    }
    return provider.openRealtimeSession(request);
  }
}

function providerNotConfiguredError(providerId: string | undefined, label: string): GoodVibesSdkError {
  return new GoodVibesSdkError(
    providerId ? `${label} is unavailable: ${providerId}` : `${label} is not registered`,
    {
      code: 'PROVIDER_NOT_CONFIGURED',
      category: DaemonErrorCategory.CONFIG,
      source: 'provider',
      recoverable: false,
      ...(providerId ? { provider: providerId } : {}),
    },
  );
}
