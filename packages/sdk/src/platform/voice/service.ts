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

/** One billable voice call (metered providers only; local emits nothing). */
export interface VoiceBillableUsage {
  readonly providerId: string;
  readonly modelId: string | undefined;
  readonly kind: 'tts' | 'stt';
  /** The provider's billable unit count: characters submitted for TTS, seconds of audio for STT. */
  readonly billableUnits: number;
  readonly unit: 'characters' | 'seconds';
}

export class VoiceService {
  constructor(
    private readonly registry: VoiceProviderRegistry,
    /** Cost-attribution sink for METERED providers (wired by the runtime root). */
    private readonly onBillableUsage?: ((usage: VoiceBillableUsage) => void) | undefined,
  ) {}

  /** Record a metered call; a provider with billing 'none' emits nothing (honest no-dimension). */
  private recordUsage(provider: { id: string; billing?: 'metered' | 'none' | undefined }, usage: Omit<VoiceBillableUsage, 'providerId'>): void {
    if (provider.billing === 'none') return;
    if (usage.billableUnits <= 0) return;
    try {
      this.onBillableUsage?.({ providerId: provider.id, ...usage });
    } catch {
      // A cost sink failure must never fail the voice call.
    }
  }

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
    const result = await provider.synthesize(request);
    this.recordUsage(provider, { modelId: request.modelId, kind: 'tts', billableUnits: request.text.length, unit: 'characters' });
    return result;
  }

  async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
    const provider = this.registry.findProvider('tts-stream', providerId);
    if (!provider?.synthesizeStream) {
      throw providerNotConfiguredError(providerId, 'Voice streaming TTS provider');
    }
    const result = await provider.synthesizeStream(request);
    // Streaming TTS bills on the submitted characters (the provider's own
    // billing unit) — recorded at accept time, not per chunk.
    this.recordUsage(provider, { modelId: request.modelId, kind: 'tts', billableUnits: request.text.length, unit: 'characters' });
    return result;
  }

  async transcribe(providerId: string | undefined, request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const provider = this.registry.findProvider('stt', providerId);
    if (!provider?.transcribe) {
      throw providerNotConfiguredError(providerId, 'Voice STT provider');
    }
    const result = await provider.transcribe(request);
    // STT bills on audio seconds where known; a provider that reported no
    // duration falls back to 1 second minimum so metered usage is never lost.
    const seconds = request.audio.durationMs !== undefined ? Math.max(1, Math.round(request.audio.durationMs / 1000)) : 1;
    this.recordUsage(provider, { modelId: request.modelId, kind: 'stt', billableUnits: seconds, unit: 'seconds' });
    return result;
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
