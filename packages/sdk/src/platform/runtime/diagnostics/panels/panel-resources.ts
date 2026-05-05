/**
 * Panel resource diagnostics panel data provider.
 *
 * Polls the shared ComponentHealthMonitor and produces ComponentResourceSnapshot
 * values for the panel resource diagnostics view.
 *
 * Subscribers are notified on each poll cycle. The poll interval is
 * configurable; callers can also request an immediate snapshot via
 * getSnapshot().
 */
import type { ComponentHealthMonitor } from '../../perf/component-health-monitor.js';
import type { ComponentResourceEntry, ComponentResourceSnapshot, DiagnosticPanelIssue } from '../types.js';
import { summarizeError } from '../../../utils/error-display.js';
import { logger } from '../../../utils/logger.js';

/** Default poll interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Severity order for sorting: overloaded > warning > healthy. */
const HEALTH_ORDER: Record<string, number> = {
  overloaded: 0,
  warning: 1,
  healthy: 2,
};

/**
 * PanelResourcesPanel — diagnostic data provider for panel resource health.
 *
 * Polls the ComponentHealthMonitor on a configurable interval and maintains a
 * current ComponentResourceSnapshot for the diagnostics panel to render.
 */
export class PanelResourcesPanel {
  private readonly _pollIntervalMs: number;
  private readonly _monitor: ComponentHealthMonitor;
  private _current: ComponentResourceSnapshot;
  private _timerId: ReturnType<typeof setInterval> | null = null;
  private readonly _subscribers = new Set<() => void>();

  constructor(monitor: ComponentHealthMonitor, pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    this._monitor = monitor;
    this._pollIntervalMs = pollIntervalMs;
    this._current = this._emptySnapshot(Date.now());
    this._refreshWithResilience(Date.now());
  }

  /**
   * Start polling the health monitor.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this._timerId !== null) return;
    this._timerId = setInterval(() => {
      this._refreshWithResilience(Date.now());
      this._notify();
    }, this._pollIntervalMs);
    this._timerId.unref?.();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Return the most recent panel resource snapshot.
   */
  getSnapshot(): ComponentResourceSnapshot {
    return this._current;
  }

  /**
   * Force an immediate snapshot refresh and return it.
   */
  refresh(now: number = Date.now()): ComponentResourceSnapshot {
    this._refreshWithResilience(now);
    return this._current;
  }

  /**
   * Register a callback invoked whenever the snapshot is refreshed.
   * @returns An unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Stop polling and clear all subscribers.
   */
  dispose(): void {
    this.stop();
    this._subscribers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _buildSnapshot(capturedAt: number): ComponentResourceSnapshot {
    const issues: DiagnosticPanelIssue[] = [];
    let healthStates: ReturnType<ComponentHealthMonitor['getAllHealth']>;
    try {
      healthStates = this._monitor.getAllHealth();
    } catch (error) {
      const message = summarizeError(error);
      logger.warn('[PanelResourcesPanel] component health collection failed', { error: message });
      throw new Error(`Component health collection failed: ${message}`);
    }

    const panels: ComponentResourceEntry[] = healthStates.map((h) => {
      let contract: ReturnType<ComponentHealthMonitor['getContract']>;
      try {
        contract = this._monitor.getContract(h.componentId);
      } catch (error) {
        const message = summarizeError(error);
        issues.push({
          severity: 'warn',
          code: 'component_contract_collection_failed',
          message: `Failed to collect resource contract for component '${h.componentId}': ${message}`,
          source: 'PanelResourcesPanel',
          context: { componentId: h.componentId },
        });
        logger.warn('[PanelResourcesPanel] component contract collection failed', {
          componentId: h.componentId,
          error: message,
        });
        contract = undefined;
      }
      return {
        componentId: h.componentId,
        throttleStatus: h.throttleStatus,
        healthStatus: h.healthStatus,
        renderP95Ms: h.renderP95Ms,
        maxRenderMs: contract?.maxRenderMs ?? 0,
        rendersInWindow: h.rendersInWindow,
        maxUpdatesPerSecond: contract?.maxUpdatesPerSecond ?? 0,
        consecutiveViolations: h.consecutiveViolations,
        totalSuppressed: h.totalSuppressed,
        totalPermitted: h.totalPermitted,
        lastRenderAt: h.lastRenderAt,
        nextAllowedAt: h.nextAllowedAt,
      };
    });

    // Sort: overloaded first, then warning, then healthy; alphabetical within tier
    panels.sort((a, b) => {
      const diff = (HEALTH_ORDER[a.healthStatus] ?? 2) - (HEALTH_ORDER[b.healthStatus] ?? 2);
      return diff !== 0 ? diff : a.componentId.localeCompare(b.componentId);
    });

    const overloadedCount = panels.filter((p) => p.healthStatus === 'overloaded').length;
    const warningCount = panels.filter((p) => p.healthStatus === 'warning').length;
    const healthyCount = panels.filter((p) => p.healthStatus === 'healthy').length;
    const totalSuppressed = panels.reduce((sum, p) => sum + p.totalSuppressed, 0);

    return {
      panels,
      overloadedCount,
      warningCount,
      healthyCount,
      totalSuppressed,
      capturedAt,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }

  private _refreshWithResilience(capturedAt: number): void {
    try {
      this._current = this._buildSnapshot(capturedAt);
    } catch (error) {
      const message = summarizeError(error);
      this._current = {
        ...this._current,
        capturedAt,
        issues: [
          ...(this._current.issues ?? []).filter((issue) => issue.code !== 'resource_snapshot_failed'),
          {
            severity: 'error',
            code: 'resource_snapshot_failed',
            message: `Panel resource snapshot refresh failed; showing previous snapshot: ${message}`,
            source: 'PanelResourcesPanel',
          },
        ],
      };
    }
  }

  private _emptySnapshot(capturedAt: number): ComponentResourceSnapshot {
    return {
      panels: [],
      overloadedCount: 0,
      warningCount: 0,
      healthyCount: 0,
      totalSuppressed: 0,
      capturedAt,
    };
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (error) {
        logger.warn('[PanelResourcesPanel] subscriber error', { error: summarizeError(error) });
      }
    }
  }
}
