/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { spawn } from 'node:child_process';
import { summarizeError } from './error-display.js';
import { logger } from './logger.js';

const OPEN_EXTERNAL_TIMEOUT_MS = 5000;

function trimOutput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function spawnLauncher(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      logger.warn('External URL launcher failed', {
        command,
        argCount: args.length,
        error: summarizeError(error),
      });
      resolve(false);
      return;
    }

    const finish = (ok: boolean, detail?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!ok) {
        logger.warn('External URL launcher failed', {
          command,
          argCount: args.length,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          ...detail,
        });
      }
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(false, { error: `timed out after ${OPEN_EXTERNAL_TIMEOUT_MS}ms` });
    }, OPEN_EXTERNAL_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.once('error', (error) => {
      finish(false, { error: summarizeError(error) });
    });
    child.once('close', (code, signal) => {
      finish(code === 0, { exitCode: code, signal });
    });
  });
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    return spawnLauncher('open', [url]);
  }

  if (process.platform === 'win32') {
    return spawnLauncher('cmd.exe', ['/c', 'start', '', url]);
  }

  if (process.env['WSL_DISTRO_NAME']) {
    if (await spawnLauncher('wslview', [url])) return true;
    if (await spawnLauncher('cmd.exe', ['/c', 'start', '', url])) return true;
  }

  return spawnLauncher('xdg-open', [url]);
}
