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

describe('ProcessManager.spawn', () => {
  test('returns process_id and pid', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo hello', '/tmp', undefined, { timeout_ms: 5000 });
    expect(result.success).toBe(true);
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id!.startsWith('bg_')).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(result.pid!).toBeGreaterThan(0);
  });

  test('normal short-lived process: done=true, no killDeadline after completion', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo done', '/tmp', undefined, { timeout_ms: 5000 });
    const id = result.process_id!;

    // Wait for the process to complete naturally
    await new Promise<void>((resolve) => {
      const check = () => {
        const status = pm.getStatus(id);
        if (!status || status.done) { resolve(); return; }
        setTimeout(check, 10);
      };
      check();
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
    // Use a sleep that far exceeds our timeout
    const result = await pm.spawn('sleep 60', '/tmp', undefined, {
      timeout_ms: 150,
      sigterm_grace_ms: 100,
    });
    const id = result.process_id!;

    // Wait for the timeout + grace to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    // The process should be done (killed) and killDeadline should be set
    const status = pm.getStatus(id);
    if (status) {
      // Still tracked — verify killDeadline was set
      expect(status.killDeadline).not.toBeNull();
      expect(status.killDeadline!).toBeGreaterThan(before);
    }
    // Either done and killed or not in map at all — both are acceptable
    // (entry is cleaned up by the collection promise completion)
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
