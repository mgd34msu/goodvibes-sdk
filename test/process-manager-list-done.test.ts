/**
 * ProcessManager.list: whether a process has ended is a field, not a parse.
 *
 * `status` describes how a process ended, and only a clean exit reads
 * "done (exit N)": a timeout reads "timed out (signal …)" and a kill reads
 * "killed by …". The TUI decided "still running" by `!status.startsWith('done')`,
 * so the live run's timed-out tick loop was counted as running after its pid
 * was gone. `done` answers that directly.
 */
import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { waitFor } from './_helpers/test-timeout.js';

describe('ProcessManager.list: done', () => {
  test('a process ended by its timeout lists done:true though its status does not start with "done"', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', '/tmp', undefined, { timeout_ms: 50, sigterm_grace_ms: 30 });
    const id = result.process_id!;
    expect(pm.list().find((p) => p.id === id)?.done).toBe(false);

    await waitFor(() => pm.getStatus(id)?.done === true);

    const listed = pm.list().find((p) => p.id === id)!;
    expect(listed.done).toBe(true);
    expect(listed.status.startsWith('done')).toBe(false);
    expect(listed.status).toContain('timed out');
  });

  test('a clean exit lists done:true', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('true', '/tmp', undefined, { timeout_ms: 5000 });
    const id = result.process_id!;
    await waitFor(() => pm.getStatus(id)?.done === true);
    expect(pm.list().find((p) => p.id === id)).toMatchObject({ done: true, status: 'done (exit 0)' });
  });
});
