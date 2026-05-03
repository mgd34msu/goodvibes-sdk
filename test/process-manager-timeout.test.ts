/**
 * γ2: ProcessManager.spawn timeout + SIGKILL deadline + error surfacing
 *
 * Tests:
 * a) Hanging process: spawn with timeout_ms:100 — verifies killDeadline is set
 * b) Normal short-lived process: exits cleanly, no killDeadline
 * c) spawn returns a process_id and pid
 */
import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { waitFor } from './_helpers/test-timeout.js';

describe('ProcessManager.spawn', () => {
  test('returns process_id and pid', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo hello', '/tmp', undefined, { timeout_ms: 5000 });
    expect(result.success).toBe(true);
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id!.startsWith('bg_')).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(Number.isInteger(result.pid)).toBe(true);
    expect(result.pid).not.toBe(process.pid);
  });

  test('normal short-lived process: done=true, no killDeadline after completion', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo done', '/tmp', undefined, { timeout_ms: 5000 });
    const id = result.process_id!;

    await waitFor(() => {
      const status = pm.getStatus(id);
      return status === null || status.done === true;
    });

    const status = pm.getStatus(id);
    // killDeadline should NOT have been set for a fast-exiting process
    expect(status?.killDeadline).toBeNull();
    expect(status?.done).toBe(true);
    expect(status?.exitCode).toBe(0);
  });

  test('hanging process: SIGKILL deadline is set after timeout', async () => {
    const pm = new ProcessManager();
    const before = Date.now();
    // Use a sleep that exceeds the short timeout but keeps the test bounded.
    const result = await pm.spawn('sleep 10', '/tmp', undefined, {
      timeout_ms: 50,
      sigterm_grace_ms: 30,
    });
    const id = result.process_id!;

    await waitFor(() => {
      const status = pm.getStatus(id);
      return status === null || status.killDeadline !== null;
    }, { timeoutMs: 500 });

    const status = pm.getStatus(id);
    expect(status === null || status.killDeadline !== null).toBe(true);
    if (status) expect(status.killDeadline!).toBeGreaterThan(before);
  }, 2000);

  test('bg_list and bg_status commands work', async () => {
    const pm = new ProcessManager();
    await pm.spawn('sleep 1', '/tmp', undefined, { timeout_ms: 5000 });
    const listResult = pm.handleCommand('bg_list');
    expect(listResult).not.toBeNull();
    expect(listResult!.success).toBe(true);
    const list = JSON.parse(listResult!.stdout) as Array<{ id: string; status: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);

    const id = list[0].id;
    const statusResult = pm.handleCommand(`bg_status ${id}`);
    expect(statusResult).not.toBeNull();
    expect(statusResult!.success).toBe(true);

    // Clean up
    pm.stop(id);
  }, 5000);
});
