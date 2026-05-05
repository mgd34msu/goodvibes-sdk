import { describe, expect, spyOn, test, type Mock } from 'bun:test';
import { StateInspectorPanel } from '../packages/sdk/src/platform/runtime/diagnostics/panels/state-inspector.js';
import { PanelResourcesPanel } from '../packages/sdk/src/platform/runtime/diagnostics/panels/panel-resources.js';
import { HealthPanel } from '../packages/sdk/src/platform/runtime/diagnostics/panels/health.js';
import { RuntimeHealthAggregator } from '../packages/sdk/src/platform/runtime/health/aggregator.js';
import { safeCheck } from '../packages/sdk/src/platform/runtime/ops/safe-check.js';
import { ForensicsRegistry } from '../packages/sdk/src/platform/runtime/forensics/registry.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';
import type { ComponentHealthMonitor } from '../packages/sdk/src/platform/runtime/perf/component-health-monitor.js';
import type { SloCollector } from '../packages/sdk/src/platform/runtime/perf/slo-collector.js';
import type { CascadeTimer } from '../packages/sdk/src/platform/runtime/health/cascade-timing.js';
import type { FailureReport } from '../packages/sdk/src/platform/runtime/forensics/types.js';

function warningMessages(warnSpy: Mock<typeof logger.warn>): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

function makeFailureReport(overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    id: 'report-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    generatedAt: 100,
    classification: 'unknown',
    summary: 'Failure summary',
    phaseTimings: [],
    phaseLedger: [],
    causalChain: [],
    cascadeEvents: [],
    permissionEvidence: [],
    budgetBreaches: [],
    jumpLinks: [],
    ...overrides,
  };
}

describe('diagnostics panels — degraded collection metadata', () => {
  test('state inspector returns partial domains with panel issues when a domain fails', () => {
    const panel = new StateInspectorPanel([
      {
        name: 'ok',
        getRevision: () => 1,
        getLastUpdatedAt: () => 100,
        getState: () => ({ ready: true }),
      },
      {
        name: 'bad',
        getRevision: () => {
          throw new Error('revision unavailable');
        },
        getLastUpdatedAt: () => 200,
        getState: () => ({ ready: false }),
      },
    ]);

    const snapshot = panel.getSnapshot();

    expect(snapshot.domains.map((entry) => entry.domain)).toEqual(['ok']);
    expect(snapshot.issues?.[0]?.code).toBe('domain_snapshot_failed');
    expect(snapshot.issues?.[0]?.context?.domain).toBe('bad');
  });

  test('panel resources keeps previous snapshot and records an issue when monitor collection fails', () => {
    let fail = false;
    const monitor = {
      getAllHealth: () => {
        if (fail) throw new Error('monitor unavailable');
        return [{
          componentId: 'panel.tasks',
          throttleStatus: 'normal',
          healthStatus: 'healthy',
          renderP95Ms: 4,
          rendersInWindow: 1,
          consecutiveViolations: 0,
          totalSuppressed: 0,
          totalPermitted: 1,
          lastRenderAt: 10,
          nextAllowedAt: 0,
        }];
      },
      getContract: () => ({
        componentId: 'panel.tasks',
        category: 'diagnostics',
        maxRenderMs: 16,
        maxUpdatesPerSecond: 30,
        throttleIntervalMs: 100,
        degradedIntervalMs: 1000,
        degradeAfterViolations: 3,
      }),
    } as unknown as ComponentHealthMonitor;

    const panel = new PanelResourcesPanel(monitor);
    expect(panel.getSnapshot().panels).toHaveLength(1);

    fail = true;
    const snapshot = panel.refresh(123);

    expect(snapshot.panels).toHaveLength(1);
    expect(snapshot.capturedAt).toBe(123);
    expect(snapshot.issues?.[0]?.code).toBe('resource_snapshot_failed');
  });

  test('panel resources returns partial rows with issue metadata when contract collection fails', () => {
    const monitor = {
      getAllHealth: () => [{
        componentId: 'panel.tasks',
        throttleStatus: 'normal',
        healthStatus: 'healthy',
        renderP95Ms: 4,
        rendersInWindow: 1,
        consecutiveViolations: 0,
        totalSuppressed: 0,
        totalPermitted: 1,
        lastRenderAt: 10,
        nextAllowedAt: 0,
      }],
      getContract: () => {
        throw new Error('contract unavailable');
      },
    } as unknown as ComponentHealthMonitor;

    const panel = new PanelResourcesPanel(monitor);
    const snapshot = panel.getSnapshot();

    expect(snapshot.panels).toHaveLength(1);
    expect(snapshot.panels[0]?.maxRenderMs).toBe(0);
    expect(snapshot.issues?.[0]?.code).toBe('component_contract_collection_failed');
    expect(snapshot.issues?.[0]?.context?.componentId).toBe('panel.tasks');
  });

  test('health panel includes issue metadata when SLO collection fails', () => {
    const aggregator = new RuntimeHealthAggregator(() => 100);
    const sloCollector = {
      getMetrics: () => {
        throw new Error('slo storage unavailable');
      },
      getSampleCounts: () => ({}),
    } as unknown as SloCollector;

    const panel = new HealthPanel(aggregator, sloCollector);
    const snapshot = panel.getSnapshot();

    expect(snapshot.domains.length).toBeGreaterThan(0);
    expect(snapshot.sloRows).toEqual([]);
    expect(snapshot.issues?.[0]?.code).toBe('slo_collection_failed');
  });

  test('health panel includes issue metadata when remediation collection fails', () => {
    const aggregator = new RuntimeHealthAggregator(() => 100);
    const cascadeTimer = {
      evaluate: () => {
        throw new Error('cascade unavailable');
      },
    } as unknown as CascadeTimer;

    const panel = new HealthPanel(aggregator, null, cascadeTimer);
    aggregator.updateDomainHealth('tasks', 'failed', { failureReason: 'task failure' });
    const snapshot = panel.getSnapshot();

    expect(snapshot.failedDomains).toContain('tasks');
    expect(snapshot.remediationActions).toEqual([]);
    expect(snapshot.issues?.[0]?.code).toBe('remediation_collection_failed');
    expect(snapshot.issues?.[0]?.context?.domain).toBe('tasks');
  });

  test('panel subscriber failures are warned and do not stop other subscribers', () => {
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const panel = new StateInspectorPanel();
      let notified = false;
      panel.subscribe(() => {
        throw new Error('subscriber failed');
      });
      panel.subscribe(() => {
        notified = true;
      });

      expect(() => panel.registerDomain({
        name: 'ok',
        getRevision: () => 1,
        getLastUpdatedAt: () => 100,
        getState: () => ({ ready: true }),
      })).not.toThrow();

      expect(notified).toBe(true);
      expect(warningMessages(warnSpy)).toContain('[StateInspectorPanel] subscriber error');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('forensics registry subscriber failures are warned without rejecting reports', () => {
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const registry = new ForensicsRegistry();
      let notified = false;
      registry.subscribe(() => {
        throw new Error('subscriber failed');
      });
      registry.subscribe(() => {
        notified = true;
      });

      expect(() => registry.push(makeFailureReport())).not.toThrow();

      expect(registry.count()).toBe(1);
      expect(notified).toBe(true);
      expect(warningMessages(warnSpy)).toContain('Forensics registry subscriber failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('safeCheck uses current diagnostic collection failure wording', async () => {
    const result = await safeCheck(async () => {
      throw new Error('probe failed');
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain('Diagnostic check failed while collecting evidence');
    expect(result.summary).toContain('probe failed');
  });
});
