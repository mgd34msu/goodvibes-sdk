import { describe, expect, test } from 'bun:test';
import {
  getAutoCompactDecision,
  shouldAutoCompact,
} from '../packages/sdk/src/platform/core/context-compaction.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { emitOpsContextWarning } from '../packages/sdk/src/platform/runtime/emitters/ops.ts';
import { registerBootstrapHookBridge } from '../packages/sdk/src/platform/runtime/bootstrap-hook-bridge.ts';

describe('context auto-compaction threshold', () => {
  test('uses configured percentage threshold instead of only remaining-token buffer', () => {
    expect(shouldAutoCompact({
      currentTokens: 102_400,
      contextWindow: 128_000,
      isCompacting: false,
      thresholdPercent: 80,
    })).toBe(true);
  });

  test('reports effective threshold details for UI and hooks', () => {
    const decision = getAutoCompactDecision({
      currentTokens: 102_400,
      contextWindow: 128_000,
      isCompacting: false,
      thresholdPercent: 80,
    });

    expect(decision).toMatchObject({
      shouldCompact: true,
      reason: 'threshold',
      currentTokens: 102_400,
      contextWindow: 128_000,
      usagePct: 80,
      thresholdPercent: 80,
      thresholdTokens: 102_400,
      remainingTokens: 25_600,
      safetyBufferTokens: 15_000,
    });
  });

  test('retains the remaining-token safety trigger for high configured thresholds', () => {
    const decision = getAutoCompactDecision({
      currentTokens: 115_000,
      contextWindow: 128_000,
      isCompacting: false,
      thresholdPercent: 99,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe('safety-buffer');
  });

  test('does not re-enter while compaction is active', () => {
    expect(shouldAutoCompact({
      currentTokens: 127_000,
      contextWindow: 128_000,
      isCompacting: true,
      thresholdPercent: 80,
    })).toBe(false);
  });

  test('routes safety-buffer compaction warnings as exceeded hook events', async () => {
    const bus = new RuntimeEventBus();
    const fired: Array<{ path: string; specific: string; payload: Record<string, unknown> }> = [];
    const unsubs = registerBootstrapHookBridge({
      runtimeBus: bus,
      hookDispatcher: {
        fire(event) {
          fired.push({
            path: event.path,
            specific: event.specific,
            payload: event.payload,
          });
          return Promise.resolve({ ok: true });
        },
      } as never,
      runtime: { sessionId: 'session-1' } as never,
    });

    try {
      emitOpsContextWarning(bus, {
        sessionId: 'session-1',
        traceId: 'trace-1',
        source: 'test',
      }, {
        usage: 90,
        threshold: 99,
        currentTokens: 115_000,
        contextWindow: 128_000,
        thresholdTokens: 126_720,
        remainingTokens: 13_000,
        safetyBufferTokens: 15_000,
        reason: 'safety-buffer',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({
        path: 'Change:budget:exceeded',
        specific: 'exceeded',
        payload: { reason: 'safety-buffer' },
      });
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });
});
