/**
 * Provider health runtime data provider.
 */
import type { ProviderHealthDomainState, ProviderHealthRecord } from '../../store/domains/provider-health.js';
import type { ModelDomainState } from '../../store/domains/model.js';
import { buildFallbackChainData } from './fallback-visualizer.js';
import type {
  ProviderHealthData,
  ProviderHealthEntry,
  HealthTimeline,
  HealthTimelinePoint,
} from './types.js';

const TIMELINE_MAX_POINTS = 60;

const STATUS_ORDER: Record<string, number> = {
  degraded: 0,
  rate_limited: 1,
  auth_error: 2,
  unavailable: 3,
  unknown: 4,
  healthy: 5,
};

interface TimelineBuffer {
  readonly points: HealthTimelinePoint[];
}

export class ProviderHealthDataProvider {
  private _healthState: ProviderHealthDomainState;
  private _modelState: ModelDomainState;
  private _snapshot: ProviderHealthData;
  private readonly _subscribers = new Set<() => void>();
  private readonly _timelines = new Map<string, TimelineBuffer>();

  constructor(healthState: ProviderHealthDomainState, modelState: ModelDomainState) {
    this._healthState = healthState;
    this._modelState = modelState;
    this._seedTimelines(healthState);
    this._snapshot = this._buildSnapshot();
  }

  public getSnapshot(): ProviderHealthData {
    return this._snapshot;
  }

  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  public updateHealthState(healthState: ProviderHealthDomainState): void {
    this._healthState = healthState;
    this._appendTimelinePoints(healthState);
    this._rebuild();
  }

  public updateModelState(modelState: ModelDomainState): void {
    this._modelState = modelState;
    this._rebuild();
  }

  public dispose(): void {
    this._subscribers.clear();
  }

  private _seedTimelines(healthState: ProviderHealthDomainState): void {
    for (const [id, record] of healthState.providers) {
      const buffer: TimelineBuffer = { points: [] };
      this._timelines.set(id, buffer);
      this._appendPoint(buffer, record);
    }
  }

  private _appendTimelinePoints(healthState: ProviderHealthDomainState): void {
    for (const [id, record] of healthState.providers) {
      if (!this._timelines.has(id)) {
        this._timelines.set(id, { points: [] });
      }
      this._appendPoint(this._timelines.get(id)!, record);
    }
  }

  private _appendPoint(buffer: TimelineBuffer, record: ProviderHealthRecord): void {
    const total = record.stats.totalCalls;
    const successRate = total > 0 ? record.stats.successCalls / total : 1;
    const errorRate = total > 0 ? record.stats.errorCalls / total : 0;

    buffer.points.push({
      ts: Date.now(),
      successRate,
      avgLatencyMs: record.stats.avgLatencyMs,
      errorRate,
    });

    if (buffer.points.length > TIMELINE_MAX_POINTS) {
      buffer.points.shift();
    }
  }

  private _buildTimeline(providerId: string): HealthTimeline {
    const buffer = this._timelines.get(providerId);
    const points: readonly HealthTimelinePoint[] = buffer ? [...buffer.points] : [];
    return {
      providerId,
      points,
      length: points.length,
    };
  }

  private _rebuild(): void {
    this._snapshot = this._buildSnapshot();
    this._notify();
  }

  private _buildSnapshot(): ProviderHealthData {
    const entries: ProviderHealthEntry[] = [];

    for (const [id, record] of this._healthState.providers) {
      const total = record.stats.totalCalls;
      const successRate = total > 0 ? record.stats.successCalls / total : 1;
      const errorRate = total > 0 ? record.stats.errorCalls / total : 0;

      entries.push({
        providerId: id,
        displayName: record.displayName,
        status: record.status,
        isActive: record.isActive,
        isConfigured: record.isConfigured,
        successRate,
        errorRate,
        p95LatencyMs: record.stats.maxLatencyMs,
        avgLatencyMs: record.stats.avgLatencyMs,
        totalCalls: total,
        cacheHitRate: record.cacheMetrics?.hitRate,
        cacheReadTokens: record.cacheMetrics?.cacheReadTokens,
        cacheWriteTokens: record.cacheMetrics?.cacheWriteTokens,
        lastSuccessAt: record.stats.lastSuccessAt,
        lastErrorAt: record.stats.lastErrorAt,
        lastErrorMessage: record.stats.lastErrorMessage,
        lastCheckedAt: record.lastCheckedAt,
        rateLimitResetAt: record.rateLimitResetAt,
        timeline: this._buildTimeline(id),
      });
    }

    entries.sort((a, b) => {
      const diff = (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
      return diff !== 0 ? diff : a.displayName.localeCompare(b.displayName);
    });

    const fallbackChain = buildFallbackChainData(this._modelState, this._healthState);

    return {
      entries,
      compositeStatus: this._healthState.compositeStatus,
      degradedCount: this._healthState.degradedCount,
      unavailableCount: this._healthState.unavailableCount,
      fallbackChain,
      warnings: this._healthState.warnings,
      snapshotAt: Date.now(),
    };
  }

  private _notify(): void {
    for (const callback of this._subscribers) {
      try {
        callback();
      } catch {
        // Subscriber failures are intentionally non-fatal.
      }
    }
  }
}
