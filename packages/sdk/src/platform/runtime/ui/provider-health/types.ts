import type { ProviderStatus, CompositeHealthStatus } from '../../store/domains/provider-health.js';

export type { ProviderStatus, CompositeHealthStatus };

export interface HealthTimelinePoint {
  readonly ts: number;
  readonly successRate: number;
  readonly avgLatencyMs: number;
  readonly errorRate: number;
}

export interface HealthTimeline {
  readonly providerId: string;
  readonly points: readonly HealthTimelinePoint[];
  readonly length: number;
}

export interface ProviderHealthEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly status: ProviderStatus;
  readonly isActive: boolean;
  readonly isConfigured: boolean;
  readonly successRate: number;
  readonly errorRate: number;
  readonly p95LatencyMs: number;
  readonly avgLatencyMs: number;
  readonly totalCalls: number;
  readonly cacheHitRate?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly lastSuccessAt?: number | undefined;
  readonly lastErrorAt?: number | undefined;
  readonly lastErrorMessage?: string | undefined;
  readonly lastCheckedAt?: number | undefined;
  readonly rateLimitResetAt?: number | undefined;
  readonly timeline: HealthTimeline;
}

export interface FallbackChainNode {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly position: number;
  readonly isCurrent: boolean;
  readonly providerStatus: ProviderStatus;
  readonly reason?: string | undefined;
}

export interface FallbackChainData {
  readonly nodes: readonly FallbackChainNode[];
  readonly activeIndex: number;
  readonly falloverCount: number;
  readonly hasUnhealthyNode: boolean;
}

export interface ProviderHealthData {
  readonly entries: readonly ProviderHealthEntry[];
  readonly compositeStatus: CompositeHealthStatus;
  readonly degradedCount: number;
  readonly unavailableCount: number;
  readonly fallbackChain: FallbackChainData;
  readonly warnings: readonly string[];
  readonly snapshotAt: number;
}
