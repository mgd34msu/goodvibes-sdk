/**
 * The machine half of the Google connector.
 *
 * Everything else in this module is policy over injected ports, so the whole
 * connector — consent, token refresh, the Gmail and Calendar calls, the setup
 * flows, the console walkthrough — runs in a test with no filesystem, no
 * socket, no subprocess and no browser. That property is only worth anything
 * if the concrete implementations live somewhere separate, and this is that
 * somewhere: four small adapters, each the ONLY place its kind of I/O happens.
 *
 *   - `nodeGoogleFilePort`      reads files (never writes: adoption reads
 *                               another tool's credentials and must not touch
 *                               them)
 *   - `createProcessCommandPort` spawns subprocesses, for the gcloud driver
 *   - `startLoopbackListener`   binds the loopback port Google redirects to
 *   - `createFetchCalDavHttpPort` performs CalDAV HTTP
 *
 * This entry is deliberately NOT re-exported from the module index: importing
 * the connector must never drag a runtime-specific implementation in behind
 * it. A consumer asks for these by name, from here.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { GoogleFilePort } from './credential-adoption.js';
import type { GoogleCommandPort } from './types.js';
import { GCLOUD_DEFAULT_TIMEOUT_MS } from './gcloud.js';
import {
  classifyLoopbackRedirect,
  type LoopbackCodeResult,
  type LoopbackListener,
  type StartLoopbackListenerOptions,
} from './oauth-loopback.js';
import type { CalDavHttpPort, CalDavHttpRequest, CalDavHttpResponse } from './caldav-client.js';

/** Plain node file reads. Adoption never writes, so there is no write side. */
export const nodeGoogleFilePort: GoogleFilePort = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/** The real command port: spawns a subprocess with a hard timeout. */
export function createProcessCommandPort(): GoogleCommandPort {
  return {
    async run(command, args, options) {
      const timeoutMs = options?.timeoutMs ?? GCLOUD_DEFAULT_TIMEOUT_MS;
      const env = options?.env;
      let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
      try {
        proc = Bun.spawn([command, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, ...(env ?? {}) },
        });
      } catch (error) {
        return {
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error),
        };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      clearTimeout(timer);
      return { code, stdout, stderr, timedOut, spawnError: null };
    },
  };
}

/**
 * Starts the local HTTP listener the browser redirects back to. Resolves as
 * soon as the server is bound; the first well-formed redirect it receives
 * settles `waitForCode()` — later redirects to the same server are ignored.
 *
 * The decision about what a given redirect means — is it ours, does it carry a
 * code, did Google report an error — is `classifyLoopbackRedirect`, not
 * anything here, so the `state` check that defends this flow is exercised by
 * tests that never bind a port.
 */
export function startLoopbackListener(options: StartLoopbackListenerOptions): LoopbackListener {
  const host = options.host ?? '127.0.0.1';
  let settled = false;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCode!: (result: LoopbackCodeResult) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<LoopbackCodeResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler immediately, at creation, so this promise is never
  // reported as an unhandled rejection. `waitForCode` hands back this exact
  // promise (deliberately not a Promise.race derivative — a promise created
  // by racing does not inherit this early handler, and Bun.serve treats an
  // unhandled rejection surfacing during request handling as a fatal error) so
  // callers still observe the real resolution or rejection.
  codePromise.catch(() => undefined);

  function settle(action: () => void): void {
    if (settled) return;
    settled = true;
    if (activeTimer) clearTimeout(activeTimer);
    action();
  }

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    fetch(request: Request): Response {
      const outcome = classifyLoopbackRedirect(request.url, options.expectedState);
      if (outcome.kind === 'error') {
        settle(() => rejectCode(outcome.error));
      } else {
        settle(() => resolveCode(outcome.result));
      }
      return new Response(outcome.body, {
        status: outcome.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  const redirectUri = `http://${host}:${server.port}/`;

  return {
    redirectUri,
    waitForCode(timeoutMs: number): Promise<LoopbackCodeResult> {
      activeTimer = setTimeout(() => {
        settle(() => rejectCode(new Error('Timed out waiting for the browser redirect.')));
      }, timeoutMs);
      return codePromise;
    },
    close(): void {
      if (activeTimer) clearTimeout(activeTimer);
      server.stop(true);
    },
  };
}

/** The only place the CalDAV client performs real network I/O: a thin wrapper over the global `fetch`. */
export function createFetchCalDavHttpPort(): CalDavHttpPort {
  return {
    async request(input: CalDavHttpRequest): Promise<CalDavHttpResponse> {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers as Record<string, string>,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await response.text();
      return { status: response.status, headers, body };
    },
  };
}
