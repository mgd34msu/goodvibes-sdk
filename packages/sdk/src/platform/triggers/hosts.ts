/**
 * hosts.ts — the real effects behind the trigger family's ports.
 *
 * manager.ts holds the policy and takes every effect as an injected port, so
 * this file is the one place where that policy meets an actual subprocess and
 * an actual agent. A host wires these once at composition; tests keep using
 * fakes.
 *
 * The on-exit host is deliberately built on ProcessManager rather than a fresh
 * Bun.spawn: ProcessManager already owns the credential-env scrub, the live
 * output collection, the SIGTERM→SIGKILL watchdog and the terminating-signal
 * capture — every one of which an honest termination payload needs. Building a
 * second, thinner spawn path here would mean an on-exit trigger silently had
 * weaker guarantees than a plain background command.
 */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import type { LaunchedProcess, ObservedTermination, TriggerProcessHost } from './process-triggers.js';
import type { TriggerActionExecutor, TriggerStreamHost } from './manager-types.js';
import type { TriggerActionGrant } from './types.js';

/** ProcessManager-backed on-exit host. Binds only to processes we launched. */
export function createProcessManagerTriggerHost(processManager: ProcessManager): TriggerProcessHost {
  /** processId -> the pid/startedAt we recorded, for restart reporting only. */
  const launched = new Map<string, { pid: number; startedAt: number }>();

  return {
    async launch(spec): Promise<LaunchedProcess> {
      const result = await processManager.spawnArgv(
        spec.command,
        spec.args,
        spec.cwd,
        spec.env ? { ...spec.env } : undefined,
        {
          timeout_ms: spec.maxDurationMs,
          // 'none' closes stdin outright; 'empty' hands over a pipe that is
          // never written and therefore EOFs immediately. Neither ever waits
          // for a human.
          stdin: spec.stdin === 'empty' ? 'pipe' : 'ignore',
        },
      );
      const processId = result.process_id;
      if (!processId) {
        throw new Error(`Failed to launch supervised process: ${spec.command}`);
      }
      const record = { pid: result.pid ?? 0, startedAt: Date.now() };
      launched.set(processId, record);
      return { processId, pid: record.pid, startedAt: record.startedAt };
    },

    observe(processId: string): ObservedTermination | null {
      const entry = processManager.getStatus(processId);
      if (!entry) return null;
      return {
        running: !entry.done,
        exitCode: entry.exitCode,
        signal: entry.signal ?? null,
        timedOut: entry.timedOut === true,
        stdoutTail: entry.stdout.join(''),
        stderrTail: entry.stderr.join(''),
        ...(entry.completedAt !== undefined ? { endedAt: entry.completedAt } : {}),
      };
    },

    cancel(processId: string): void {
      processManager.stop(processId);
      launched.delete(processId);
    },

    /**
     * Reporting only — the trigger never re-binds to this pid. A pid from a
     * previous daemon boot very likely belongs to somebody else's process by
     * now, so this answers "is anything alive there" and nothing stronger.
     */
    isSameProcessAlive(pid: number, startedAt: number): boolean {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      void startedAt;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Bun-backed stream host: spawns the long-lived command from argv (no shell)
 * and pushes decoded chunks to the manager as they arrive.
 */
export function createBunStreamHost(): TriggerStreamHost {
  const running = new Map<string, { kill: () => void }>();
  let counter = 0;

  return {
    start(input) {
      const streamId = `stream_${++counter}_${Date.now()}`;
      const proc = Bun.spawn([input.command, ...input.args], {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      } as Parameters<typeof Bun.spawn>[1]);

      running.set(streamId, {
        kill: () => {
          try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        },
      });

      const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text.length > 0) input.onChunk(text);
          }
          const tail = decoder.decode();
          if (tail.length > 0) input.onChunk(tail);
        } finally {
          reader.releaseLock();
        }
      };

      void (async () => {
        try {
          await Promise.all([
            pump(proc.stdout as ReadableStream<Uint8Array>),
            pump(proc.stderr as ReadableStream<Uint8Array>),
          ]);
        } catch (error) {
          logger.warn('Stream trigger output pump failed', { streamId, error: summarizeError(error) });
        }
        const exitCode = await proc.exited.catch(() => null);
        running.delete(streamId);
        input.onExit(exitCode);
      })();

      return Promise.resolve({ streamId, pid: proc.pid });
    },

    stop(streamId: string): void {
      running.get(streamId)?.kill();
      running.delete(streamId);
    },
  };
}

/** What a fired trigger needs in order to actually start an agent turn. */
export interface TriggerAgentSpawner {
  spawn(input: { mode: 'spawn'; task: string; model?: string | undefined }): { id: string };
}

/**
 * Real fire-action executor.
 *
 * `runGrant` runs the grant's argv through the same no-shell path as an
 * on-exit child. By the time it is reached the manager has already verified
 * the digest against the registered grant, so what runs here is exactly what a
 * person confirmed.
 */
export function createTriggerActionExecutor(deps: {
  readonly agents: TriggerAgentSpawner;
  readonly processManager: ProcessManager;
  readonly grantTimeoutMs?: number | undefined;
}): TriggerActionExecutor {
  return {
    runAgentTurn(input) {
      const record = deps.agents.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
      return Promise.resolve(`agent:${record.id}`);
    },

    async runGrant(input: { readonly triggerId: string; readonly grant: TriggerActionGrant }) {
      const result = await deps.processManager.spawnArgv(
        input.grant.command,
        input.grant.args,
        input.grant.cwd,
        undefined,
        { timeout_ms: deps.grantTimeoutMs ?? 300_000, stdin: 'ignore' },
      );
      return `grant:${input.grant.id}:${result.process_id ?? 'unknown'}`;
    },
  };
}
