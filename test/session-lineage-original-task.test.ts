import { describe, expect, test } from 'bun:test';
import { SessionLineageTracker } from '../packages/sdk/src/platform/core/session-lineage.ts';

describe('SessionLineageTracker.getOriginalTask', () => {
  test('returns null before any task is set', () => {
    const tracker = new SessionLineageTracker();
    expect(tracker.getOriginalTask()).toBeNull();
  });

  test('returns the task after setOriginalTask is called', () => {
    const tracker = new SessionLineageTracker();
    tracker.setOriginalTask('Build a REST API with auth');
    expect(tracker.getOriginalTask()).toBe('Build a REST API with auth');
  });

  test('setOriginalTask is idempotent — second call is ignored', () => {
    const tracker = new SessionLineageTracker();
    tracker.setOriginalTask('first task');
    tracker.setOriginalTask('second task');
    expect(tracker.getOriginalTask()).toBe('first task');
  });

  test('reset() clears the original task back to null', () => {
    const tracker = new SessionLineageTracker();
    tracker.setOriginalTask('some task');
    tracker.reset();
    expect(tracker.getOriginalTask()).toBeNull();
  });

  test('originalTask is populated in compaction context when set', () => {
    // Verifies that getOriginalTask returns a value that can flow into
    // CompactionContext.originalTask (non-null → non-undefined conversion via ?? undefined)
    const tracker = new SessionLineageTracker();
    tracker.setOriginalTask('Implement DRY refactors');
    const originalTask = tracker.getOriginalTask() ?? undefined;
    expect(originalTask).toBe('Implement DRY refactors');
  });

  test('getOriginalTask after reset followed by new setOriginalTask works correctly', () => {
    const tracker = new SessionLineageTracker();
    tracker.setOriginalTask('session one task');
    tracker.reset();
    tracker.setOriginalTask('session two task');
    expect(tracker.getOriginalTask()).toBe('session two task');
  });
});
