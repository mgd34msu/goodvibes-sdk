/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export type VoiceProviderCapability = 'tts' | 'tts-stream' | 'stt' | 'realtime' | 'voice-list';
export type VoiceProviderState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
export type VoiceAudioFormat = 'wav' | 'mp3' | 'ogg' | 'webm' | 'pcm16' | 'flac';

export interface VoiceProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly state: VoiceProviderState;
  readonly capabilities: readonly VoiceProviderCapability[];
  readonly configured: boolean;
  readonly detail?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceDescriptor {
  readonly id: string;
  readonly label: string;
  readonly locale?: string | undefined;
  readonly gender?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceAudioArtifact {
  readonly mimeType: string;
  readonly format: VoiceAudioFormat | string;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly sampleRateHz?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceSynthesisRequest {
  readonly text: string;
  readonly voiceId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly format?: VoiceAudioFormat | string | undefined;
  readonly speed?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceSynthesisResult {
  readonly providerId: string;
  readonly audio: VoiceAudioArtifact;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceAudioChunk {
  readonly data: Uint8Array;
  readonly sequence: number;
  readonly mimeType?: string | undefined;
  readonly format?: VoiceAudioFormat | string | undefined;
  readonly final?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceSynthesisStreamResult {
  readonly providerId: string;
  readonly mimeType: string;
  readonly format: VoiceAudioFormat | string;
  readonly chunks: AsyncIterable<VoiceAudioChunk>;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceTranscriptionRequest {
  readonly audio: VoiceAudioArtifact;
  readonly language?: string | undefined;
  readonly modelId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceTranscriptionResult {
  readonly providerId: string;
  readonly text: string;
  readonly language?: string | undefined;
  readonly segments?: readonly {
    readonly text: string;
    readonly startMs?: number | undefined;
    readonly endMs?: number | undefined;
    readonly confidence?: number | undefined;
  }[];
  readonly metadata: Record<string, unknown>;
}

export interface VoiceRealtimeSessionRequest {
  readonly modelId?: string | undefined;
  readonly voiceId?: string | undefined;
  readonly inputFormat?: VoiceAudioFormat | string | undefined;
  readonly outputFormat?: VoiceAudioFormat | string | undefined;
  readonly instructions?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VoiceRealtimeSession {
  readonly providerId: string;
  readonly sessionId: string;
  readonly transport: 'websocket' | 'webrtc' | 'sse' | 'http' | 'custom';
  readonly url?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly VoiceProviderCapability[];
  status?(): Promise<VoiceProviderStatus> | VoiceProviderStatus;
  listVoices?(): Promise<readonly VoiceDescriptor[]> | readonly VoiceDescriptor[];
  synthesize?(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult>;
  synthesizeStream?(request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> | VoiceSynthesisStreamResult;
  transcribe?(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult>;
  openRealtimeSession?(request: VoiceRealtimeSessionRequest): Promise<VoiceRealtimeSession>;
}
