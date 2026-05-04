import type { ArtifactDescriptor } from '../artifacts/types.js';

export type MultimodalKind = 'image' | 'audio' | 'video' | 'document';
export type MultimodalDetail = 'compact' | 'standard' | 'detailed';

export interface MultimodalArtifactInput {
  readonly artifactId?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly filename?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MultimodalProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly transport: 'media' | 'voice' | 'extractor' | 'hybrid';
  readonly capabilities: readonly string[];
  readonly configured: boolean;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalSegment {
  readonly kind: 'transcript' | 'section' | 'scene' | 'ocr' | 'summary';
  readonly title?: string | undefined;
  readonly text?: string | undefined;
  readonly startMs?: number | undefined;
  readonly endMs?: number | undefined;
  readonly confidence?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalAnalysisRequest {
  readonly artifactId?: string | undefined;
  readonly artifact?: MultimodalArtifactInput | undefined;
  readonly prompt?: string | undefined;
  readonly imageProviderId?: string | undefined;
  readonly audioProviderId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly language?: string | undefined;
  readonly detail?: MultimodalDetail | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MultimodalAnalysisResult {
  readonly id: string;
  readonly kind: MultimodalKind;
  readonly artifact: ArtifactDescriptor;
  readonly providerIds: readonly string[];
  readonly summary?: string | undefined;
  readonly text?: string | undefined;
  readonly labels: readonly string[];
  readonly entities: readonly string[];
  readonly segments: readonly MultimodalSegment[];
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalPacket {
  readonly detail: MultimodalDetail;
  readonly budgetLimit: number;
  readonly estimatedTokens: number;
  readonly rendered: string;
  readonly highlights: readonly string[];
}

export interface MultimodalWritebackResult {
  readonly analysisArtifact: ArtifactDescriptor;
  readonly knowledgeSourceId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MultimodalServiceStatus {
  readonly enabled: boolean;
  readonly providerCount: number;
  readonly providers: readonly MultimodalProviderDescriptor[];
  readonly note: string;
}
