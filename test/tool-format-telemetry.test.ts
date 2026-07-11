import { afterEach, describe, expect, test } from 'bun:test';
import {
  ToolFormatTelemetry,
  classifyToolFormatOutcome,
} from '../packages/sdk/src/platform/runtime/telemetry/tool-format-telemetry.js';
import { resetMetrics, snapshotMetrics } from '../packages/sdk/src/platform/runtime/metrics.js';
import { toolFormatTelemetry } from '../packages/sdk/src/platform/runtime/telemetry/tool-format-telemetry.js';

describe('classifyToolFormatOutcome', () => {
  test('edit no-match, ambiguous, conflict, and generic failures', () => {
    expect(classifyToolFormatOutcome('edit', { success: false, error: 'No match found for X' }))
      .toEqual(['edit_not_found']);
    expect(classifyToolFormatOutcome('edit', { success: false, error: 'Ambiguous match: appears 3 times' }))
      .toEqual(['edit_ambiguous']);
    expect(classifyToolFormatOutcome('edit', { success: false, error: 'OCC conflict: modified externally' }))
      .toEqual(['edit_conflict']);
    expect(classifyToolFormatOutcome('edit', { success: false, error: 'something else' }))
      .toEqual(['edit_failed']);
  });

  test('edit fallback warnings on success', () => {
    expect(classifyToolFormatOutcome('edit', {
      success: true,
      warnings: ['Exact match failed; used whitespace-normalized match instead.'],
    })).toEqual(['edit_fallback_whitespace']);
    expect(classifyToolFormatOutcome('edit', {
      success: true,
      warnings: ['Exact match failed; used fuzzy line match (content may differ slightly — verify the edit).'],
    })).toEqual(['edit_fallback_fuzzy']);
    // A clean success with no fallback records nothing.
    expect(classifyToolFormatOutcome('edit', { success: true, warnings: [] })).toEqual([]);
  });

  test('exec records only declared-expectation misses, one class per violation', () => {
    const output = JSON.stringify({
      cmd: 'test', exit_code: 1, success: false,
      expectation_error: 'exit_code: expected 0, got 1; stdout_contains: \'ok\' not found',
    });
    expect(classifyToolFormatOutcome('exec', { success: false, output })).toEqual([
      'exec_expectation_exit_code',
      'exec_expectation_stdout_contains',
    ]);
    // An ordinary non-zero exit with no expectation is NOT a format regression.
    expect(classifyToolFormatOutcome('exec', {
      success: false,
      output: JSON.stringify({ cmd: 'test', exit_code: 1, success: false }),
    })).toEqual([]);
  });

  test('non-edit/exec tools are ignored', () => {
    expect(classifyToolFormatOutcome('read', { success: false, error: 'nope' })).toEqual([]);
  });
});

describe('ToolFormatTelemetry recorder', () => {
  test('counts per model and per class, matching results to calls by callId', () => {
    const t = new ToolFormatTelemetry();
    t.observeToolResults(
      'anthropic:claude',
      [{ id: 'c1', name: 'edit' }, { id: 'c2', name: 'exec' }],
      [
        { callId: 'c1', success: false, error: 'No match found for X' },
        { callId: 'c2', success: false, output: JSON.stringify({ expectation_error: 'exit_code: expected 0, got 2' }) },
      ],
    );
    t.observeToolResults(
      'anthropic:claude',
      [{ id: 'c3', name: 'edit' }],
      [{ callId: 'c3', success: false, error: 'No match found again' }],
    );
    const snap = t.snapshot();
    expect(snap.byModel['anthropic:claude']).toEqual({
      edit_not_found: 2,
      exec_expectation_exit_code: 1,
    });
    expect(snap.byClass).toEqual({ edit_not_found: 2, exec_expectation_exit_code: 1 });
  });

  test('empty snapshot is empty, not fabricated', () => {
    const t = new ToolFormatTelemetry();
    expect(t.snapshot()).toEqual({ byModel: {}, byClass: {} });
  });
});

describe('metrics snapshot integration', () => {
  afterEach(() => resetMetrics());

  test('per-model tool-format counts appear under the metrics snapshot', () => {
    toolFormatTelemetry.record('anthropic:claude', 'edit_ambiguous');
    const metrics = snapshotMetrics() as { toolFormat: { byModel: Record<string, unknown>; byClass: Record<string, number> } };
    expect(metrics.toolFormat.byModel['anthropic:claude']).toEqual({ edit_ambiguous: 1 });
    expect(metrics.toolFormat.byClass['edit_ambiguous']).toBe(1);
    resetMetrics();
    expect((snapshotMetrics() as { toolFormat: { byClass: Record<string, number> } }).toolFormat.byClass).toEqual({});
  });
});
