/**
 * Feature-flag graduation report + release gate.
 *
 * The release policy: a report passes only when nothing sits in
 * `graduate-candidate`. A validated flag must flip on (become `graduated`) or
 * record a dated blocker (become `blocked`) — otherwise it blocks the release.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildFlagGraduationReport,
  evaluateGraduationReleaseGate,
  type FlagGraduationAnnotation,
} from '../packages/sdk/src/platform/runtime/feature-flags/graduation.js';
import { FEATURE_FLAGS } from '../packages/sdk/src/platform/runtime/feature-flags/flags.js';
import type { FeatureFlag } from '../packages/sdk/src/platform/runtime/feature-flags/types.js';

function flag(id: string, defaultState: FeatureFlag['defaultState']): FeatureFlag {
  return { id, name: id, description: id, defaultState, tier: 1, runtimeToggleable: true };
}

describe('flag graduation — live registry report', () => {
  test('report covers every registered flag exactly once', () => {
    const report = buildFlagGraduationReport();
    expect(report.entries).toHaveLength(FEATURE_FLAGS.length);
    expect(report.summary.total).toBe(FEATURE_FLAGS.length);
    const ids = new Set(report.entries.map((e) => e.flagId));
    expect(ids.size).toBe(FEATURE_FLAGS.length);
  });

  test('default-on flags derive to graduated; default-off with no annotation are dark', () => {
    const report = buildFlagGraduationReport();
    const enabledCount = FEATURE_FLAGS.filter((f) => f.defaultState === 'enabled').length;
    const disabledCount = FEATURE_FLAGS.filter((f) => f.defaultState === 'disabled').length;
    expect(report.summary.graduated).toBe(enabledCount);
    expect(report.summary.dark).toBe(disabledCount);
    expect(report.summary.graduateCandidate).toBe(0);
  });

  test('the live report passes the release gate (no candidates awaiting a decision)', () => {
    const gate = evaluateGraduationReleaseGate(buildFlagGraduationReport());
    expect(gate.ok).toBe(true);
    expect(gate.blockers).toHaveLength(0);
  });

  test('flags with divergence instrumentation report it; others report no instrumentation', () => {
    const report = buildFlagGraduationReport();
    const sim = report.entries.find((e) => e.flagId === 'permissions-simulation');
    expect(sim?.evidence.instrumentation).toBe('divergence-simulation');
    expect(sim?.evidence.divergence).toBeNull();
    expect(sim?.evidence.note).toContain('no evidence collected');
    const other = report.entries.find((e) => e.flagId === 'session-compaction');
    expect(other?.evidence.instrumentation).toBe('none');
  });
});

describe('flag graduation — release gate over synthetic annotations', () => {
  const flags: FeatureFlag[] = [
    flag('ready-flag', 'disabled'),
    flag('flipped-flag', 'enabled'),
    flag('held-flag', 'disabled'),
    flag('soaking-flag', 'disabled'),
  ];

  test('a graduate-candidate with no flip and no blocker FAILS the gate', () => {
    const annotations: FlagGraduationAnnotation[] = [{ flagId: 'ready-flag', state: 'graduate-candidate' }];
    const report = buildFlagGraduationReport({ flags, annotations });
    expect(report.summary.graduateCandidate).toBe(1);
    expect(report.releaseBlockers).toEqual(['ready-flag']);
    const gate = evaluateGraduationReleaseGate(report);
    expect(gate.ok).toBe(false);
    expect(gate.blockers).toEqual(['ready-flag']);
    expect(gate.message).toContain('ready-flag');
  });

  test('flipping the flag on (default enabled) resolves it to graduated and passes', () => {
    // 'flipped-flag' defaults enabled; even a stale candidate annotation loses to the flip.
    const annotations: FlagGraduationAnnotation[] = [{ flagId: 'flipped-flag', state: 'graduate-candidate' }];
    const report = buildFlagGraduationReport({ flags, annotations });
    const entry = report.entries.find((e) => e.flagId === 'flipped-flag');
    expect(entry?.state).toBe('graduated');
    expect(evaluateGraduationReleaseGate(report).ok).toBe(true);
  });

  test('a dated blocker moves it to blocked and passes', () => {
    const annotations: FlagGraduationAnnotation[] = [
      { flagId: 'held-flag', state: 'blocked', blocker: { reason: 'perf regression', date: '2026-07-10' } },
    ];
    const report = buildFlagGraduationReport({ flags, annotations });
    const entry = report.entries.find((e) => e.flagId === 'held-flag');
    expect(entry?.state).toBe('blocked');
    expect(entry?.blocker).toEqual({ reason: 'perf regression', date: '2026-07-10' });
    expect(evaluateGraduationReleaseGate(report).ok).toBe(true);
    expect(report.releaseBlockers).toHaveLength(0);
  });

  test('a soaking flag does not block the release', () => {
    const annotations: FlagGraduationAnnotation[] = [{ flagId: 'soaking-flag', state: 'soaking' }];
    const report = buildFlagGraduationReport({ flags, annotations });
    expect(report.summary.soaking).toBe(1);
    expect(evaluateGraduationReleaseGate(report).ok).toBe(true);
  });

  test('real divergence evidence from a provider is folded into the entry', () => {
    const report = buildFlagGraduationReport({
      flags: [flag('permissions-simulation', 'disabled')],
      evidence: {
        divergenceFor: (id) =>
          id === 'permissions-simulation'
            ? { divergenceRate: 0.02, totalEvaluations: 500, gateStatus: 'allowed' }
            : null,
      },
    });
    const entry = report.entries[0]!;
    expect(entry.evidence.divergence).toEqual({ divergenceRate: 0.02, totalEvaluations: 500, gateStatus: 'allowed' });
    expect(entry.evidence.note).toContain('divergence rate 0.02');
  });
});

describe('flag graduation — annotation validation', () => {
  test('a blocked annotation without a dated blocker throws', () => {
    expect(() =>
      buildFlagGraduationReport({
        flags: [flag('x', 'disabled')],
        annotations: [{ flagId: 'x', state: 'blocked' }],
      }),
    ).toThrow(/records no dated blocker/);
  });

  test('a non-blocked annotation carrying a blocker throws', () => {
    expect(() =>
      buildFlagGraduationReport({
        flags: [flag('x', 'disabled')],
        annotations: [{ flagId: 'x', state: 'soaking', blocker: { reason: 'r', date: '2026-07-10' } }],
      }),
    ).toThrow(/not in the blocked state/);
  });

  test('an annotation for an unknown flag throws', () => {
    expect(() =>
      buildFlagGraduationReport({
        flags: [flag('x', 'disabled')],
        annotations: [{ flagId: 'nope', state: 'soaking' }],
      }),
    ).toThrow(/unknown flag/);
  });
});
