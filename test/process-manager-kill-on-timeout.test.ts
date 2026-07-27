/**
 * ProcessManager: a timeout terminates a process only when the caller allows it.
 *
 * The watchdog used to SIGTERM/SIGKILL unconditionally, so a routine timeout on
 * a process the caller did not own — a browser, an editor, a server — destroyed
 * it, reported `exitCode: null` that read as an ordinary cancellation, and
 * logged nothing. `kill_on_timeout: false` bounds the wait without ending the
 * process, and `timedOut` records that the deadline passed either way.
 */
import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { waitFor } from './_helpers/test-timeout.js';

describe('ProcessManager.spawn — kill_on_timeout', () => {
  test('a killable process is terminated when its timeout expires', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', '/tmp', undefined, {
      timeout_ms: 50,
      sigterm_grace_ms: 30,
      kill_on_timeout: true,
    });
    const id = result.process_id!;

    await waitFor(() => pm.getStatus(id)?.done === true);

    const status = pm.getStatus(id);
    expect(status?.done).toBe(true);
    expect(status?.timedOut).toBe(true);
    // Terminated by SIGTERM, which the shell reports as 128 + 15.
    expect(status?.exitCode).toBe(143);
  });

  test('kill_on_timeout:false leaves the process running past its deadline', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', '/tmp', undefined, {
      timeout_ms: 50,
      sigterm_grace_ms: 30,
      kill_on_timeout: false,
    });
    const id = result.process_id!;

    // The deadline passes...
    await waitFor(() => pm.getStatus(id)?.timedOut === true);

    const status = pm.getStatus(id);
    // ...and is recorded, but the process is untouched.
    expect(status?.timedOut).toBe(true);
    expect(status?.done).toBe(false);
    expect(status?.killDeadline).toBeNull();

    pm.stop(id);
  });

  test('the default is unchanged: a timeout still kills', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', '/tmp', undefined, {
      timeout_ms: 50,
      sigterm_grace_ms: 30,
    });
    const id = result.process_id!;

    await waitFor(() => pm.getStatus(id)?.done === true);
    expect(pm.getStatus(id)?.timedOut).toBe(true);
  });

  test('a process that finishes in time is never marked timed out', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo ok', '/tmp', undefined, {
      timeout_ms: 5_000,
      kill_on_timeout: false,
    });
    const id = result.process_id!;

    await waitFor(() => pm.getStatus(id)?.done === true);

    const status = pm.getStatus(id);
    expect(status?.exitCode).toBe(0);
    expect(status?.timedOut ?? false).toBe(false);
  });

  test('a spared process can still be stopped explicitly', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', '/tmp', undefined, {
      timeout_ms: 50,
      kill_on_timeout: false,
    });
    const id = result.process_id!;

    await waitFor(() => pm.getStatus(id)?.timedOut === true);
    expect(pm.getStatus(id)?.done).toBe(false);

    // stop() signals the process and drops its record, which is how a caller
    // ends a process whose timeout deliberately did not.
    expect(pm.stop(id)).toBe(true);
    expect(pm.getStatus(id)).toBeUndefined();
  });
});
