/**
 * power/linux-logind.ts — the Linux implementation of the power seam.
 *
 * Inhibitors are held by spawning `systemd-inhibit` (the stock unprivileged
 * logind D-Bus client — it calls org.freedesktop.login1.Manager.Inhibit and
 * holds the returned fd for the life of its child). No root, no sudo, ever:
 * an unprivileged user can always hold idle/sleep inhibitors; a lid-switch
 * block may be refused by polkit, which surfaces as an honest per-class
 * denial rather than a fake grant. Requesting classes individually is what
 * makes the per-class grant/deny split observable.
 *
 * The sleep edge is the logind PrepareForSleep signal, watched with a
 * long-lived `dbus-monitor --system` subscription (read-only; no privileges
 * required for signal watching).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from './types.js';

/** Grace period for an inhibit child to prove it started (denials exit fast). */
const START_PROBE_MS = 300;

function spawnInhibitChild(cls: PowerInhibitClass, who: string, why: string): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'systemd-inhibit',
      [`--what=${cls}`, `--who=${who}`, `--why=${why}`, '--mode=block', 'sleep', 'infinity'],
      { stdio: 'ignore', detached: false },
    );
    let settled = false;
    const settle = (value: ChildProcess | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', () => settle(null));
    // A polkit denial exits within milliseconds; a granted inhibitor's child
    // stays alive holding the fd. Probe shortly after spawn.
    child.once('exit', () => settle(null));
    setTimeout(() => {
      if (child.exitCode === null && child.pid) settle(child);
      else settle(null);
    }, START_PROBE_MS).unref?.();
  });
}

export function createLinuxLogindSeam(options: { readonly who?: string | undefined } = {}): PowerPlatformSeam {
  const who = options.who ?? 'goodvibes';
  return {
    platform: 'linux-logind',
    async isAvailable(): Promise<boolean> {
      return new Promise((resolve) => {
        execFile('systemd-inhibit', ['--list', '--no-legend'], { timeout: 5_000 }, (error) => {
          resolve(!error);
        });
      });
    },
    async inhibit(input): Promise<PowerInhibitHandle | null> {
      const children: Array<{ cls: PowerInhibitClass; child: ChildProcess }> = [];
      const granted: PowerInhibitClass[] = [];
      const denied: PowerInhibitClass[] = [];
      for (const cls of input.classes) {
        const child = await spawnInhibitChild(cls, who, input.why);
        if (child) {
          children.push({ cls, child });
          granted.push(cls);
        } else {
          denied.push(cls);
        }
      }
      if (granted.length === 0) return null;
      let released = false;
      return {
        grantedClasses: granted,
        deniedClasses: denied,
        release: async () => {
          if (released) return;
          released = true;
          for (const { cls, child } of children) {
            try {
              child.kill('SIGTERM');
            } catch (error) {
              logger.warn('[power] inhibitor release failed', { cls, error: summarizeError(error) });
            }
          }
        },
      };
    },
    onPrepareForSleep(callback): () => void {
      const monitor = spawn(
        'dbus-monitor',
        ['--system', "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'"],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let sawSignalHeader = false;
      monitor.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf-8').split('\n')) {
          if (line.includes('member=PrepareForSleep')) {
            sawSignalHeader = true;
            continue;
          }
          if (!sawSignalHeader) continue;
          const match = line.match(/boolean (true|false)/);
          if (match) {
            sawSignalHeader = false;
            try {
              callback(match[1] === 'true');
            } catch (error) {
              logger.warn('[power] PrepareForSleep callback failed', { error: summarizeError(error) });
            }
          }
        }
      });
      monitor.once('error', (error) => {
        logger.warn('[power] dbus-monitor unavailable; sleep-edge signal disabled', { error: summarizeError(error) });
      });
      monitor.unref?.();
      return () => {
        try {
          monitor.kill('SIGTERM');
        } catch {
          // already gone
        }
      };
    },
  };
}
