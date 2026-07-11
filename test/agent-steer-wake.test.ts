import { describe, expect, test } from 'bun:test';
import { AgentManager, type AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

function makeManager(runAgent: (record: AgentRecord) => Promise<void>) {
  return new AgentManager({
    configManager: { get: () => null },
    messageBus: { registerAgent() {} },
    archetypeLoader: { loadArchetype: () => null },
    executor: { runAgent },
  });
}

function spawnAndFail(manager: AgentManager, error = 'Exceeded maximum turn limit (50)'): AgentRecord {
  const record = manager.spawn({
    mode: 'spawn',
    task: 'do the thing',
    template: 'general',
    dangerously_disable_wrfc: true,
  });
  // Simulate a terminally-failed (wedged) loop.
  record.status = 'failed';
  record.error = error;
  record.completedAt = Date.now();
  return record;
}

describe('AgentManager.wakeWithSteer', () => {
  test('re-triggers a terminally-failed agent with the steer seeded for the next run', async () => {
    const runs: AgentRecord[] = [];
    // First run (from spawn) is a no-op; we drive the failure manually.
    const manager = makeManager(async (record) => { runs.push(record); });
    const record = spawnAndFail(manager);
    runs.length = 0; // ignore the spawn-time run

    const result = manager.wakeWithSteer(record.id, 'actually, focus on the parser');
    expect(result.woke).toBe(true);
    // The executor was re-invoked for this record...
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(record.id);
    // ...carrying the steer seed for runAgentTask to consume, and the prior
    // terminal outcome was cleared.
    expect(record.resumeSteer?.steer).toBe('actually, focus on the parser');
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBeUndefined();
  });

  test('does not wake a genuinely-running agent (that path stays as-is)', async () => {
    const manager = makeManager(async () => {});
    const record = manager.spawn({ mode: 'spawn', task: 't', template: 'general', dangerously_disable_wrfc: true });
    record.status = 'running';
    const result = manager.wakeWithSteer(record.id, 'steer');
    expect(result.woke).toBe(false);
    expect(result.reason).toContain('running');
  });

  test('does not wake a completed or cancelled agent, and reports unknown agents', async () => {
    const manager = makeManager(async () => {});
    const completed = manager.spawn({ mode: 'spawn', task: 't', template: 'general', dangerously_disable_wrfc: true });
    completed.status = 'completed';
    expect(manager.wakeWithSteer(completed.id, 'steer').woke).toBe(false);
    expect(manager.wakeWithSteer('nope', 'steer')).toEqual({ woke: false, reason: 'unknown-agent' });
  });

  test('refuses an empty steer message', async () => {
    const manager = makeManager(async () => {});
    const record = spawnAndFail(manager);
    expect(manager.wakeWithSteer(record.id, '   ').woke).toBe(false);
  });
});
