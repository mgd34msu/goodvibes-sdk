/**
 * remote-access/tailscale.ts
 *
 * Tailscale as the recommended path to https without the daemon ever minting a
 * certificate (self-provisioned CAs are ruled out; `tailscale serve` terminates
 * TLS with tailscale's own certificates, which is tailscale's business, never
 * the daemon's).
 *
 * Two operations, cleanly split by side effect:
 *  - `detectTailscale` is STRICTLY READ-ONLY: is the binary present, is the
 *    node logged in, what is the MagicDNS name. It never invokes a
 *    state-changing tailscale command. Where tailscale is absent, the result
 *    says so once and nothing nags.
 *  - `enableTailscaleServe` is the ONE state-changing action (`tailscale serve
 *    --bg <port>`), run only from the explicit user-initiated verb, recorded
 *    with an honest receipt either way.
 *
 * The command runner is injectable so tests never touch a real tailscale.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

/** Injectable command execution seam. */
export interface TailscaleCommandRunner {
  run(command: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string };
}

const COMMAND_TIMEOUT_MS = 10_000;

/** Real runner: spawnSync with a hard timeout, never a shell. */
export function defaultTailscaleRunner(): TailscaleCommandRunner {
  return {
    run(command, args) {
      try {
        const result = spawnSync(command, [...args], { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS });
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      } catch (error) {
        return { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Read-only detection result — what a surface needs to offer (or not offer) the affordance. */
export interface TailscaleDetection {
  /** The tailscale binary exists and answered. */
  readonly available: boolean;
  /** The node is logged in and running. */
  readonly loggedIn: boolean;
  /** The node's MagicDNS name (trailing dot stripped), when logged in. */
  readonly magicDnsName?: string | undefined;
  /** The https URL `tailscale serve` would yield, when a MagicDNS name exists. */
  readonly httpsUrl?: string | undefined;
  /** Plain-language state, honest about what was (not) found. */
  readonly detail: string;
}

/**
 * Detect a usable tailscale environment. READ-ONLY: `tailscale status --json`
 * only — never up/login/serve/set. Absence is a quiet, honest result, not an
 * error and never a nag.
 */
export function detectTailscale(runner: TailscaleCommandRunner = defaultTailscaleRunner()): TailscaleDetection {
  const status = runner.run('tailscale', ['status', '--json']);
  if (status.status === null) {
    return { available: false, loggedIn: false, detail: 'tailscale binary not found' };
  }
  let parsed: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed;
  } catch {
    return {
      available: true,
      loggedIn: false,
      detail: `tailscale answered but its status was unreadable${status.stderr ? `: ${status.stderr.trim()}` : ''}`,
    };
  }
  const loggedIn = parsed.BackendState === 'Running';
  const rawDnsName = parsed.Self?.DNSName?.replace(/\.$/, '') ?? '';
  if (!loggedIn) {
    return {
      available: true,
      loggedIn: false,
      detail: `tailscale is installed but not connected (state: ${parsed.BackendState ?? 'unknown'})`,
    };
  }
  if (!rawDnsName) {
    return { available: true, loggedIn: true, detail: 'tailscale is connected but reports no MagicDNS name' };
  }
  return {
    available: true,
    loggedIn: true,
    magicDnsName: rawDnsName,
    httpsUrl: `https://${rawDnsName}`,
    detail: `tailscale is connected as ${rawDnsName}`,
  };
}

/** The honest record of one serve attempt — persisted either way. */
export interface TailscaleServeReceipt {
  readonly at: number;
  readonly command: string;
  readonly ok: boolean;
  /** The https MagicDNS URL now fronting the daemon, on success. */
  readonly url?: string | undefined;
  readonly detail: string;
}

/**
 * Run `tailscale serve --bg <port>` — the ONE state-changing tailscale action,
 * invoked only from the explicit user-initiated verb. Returns an honest receipt
 * either way; the caller persists it and updates web.publicBaseUrl on success.
 */
export function enableTailscaleServe(
  port: number,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): TailscaleServeReceipt {
  const command = `tailscale serve --bg ${port}`;
  const detection = detectTailscale(runner);
  if (!detection.available || !detection.loggedIn || !detection.httpsUrl) {
    return { at: Date.now(), command, ok: false, detail: detection.detail };
  }
  const result = runner.run('tailscale', ['serve', '--bg', String(port)]);
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || result.stdout.trim() || 'tailscale serve failed';
    return { at: Date.now(), command, ok: false, detail: stderr };
  }
  return {
    at: Date.now(),
    command,
    ok: true,
    url: detection.httpsUrl,
    detail: `tailscale serve is fronting port ${port} at ${detection.httpsUrl}`,
  };
}

const MAX_RECEIPTS = 20;

/** Bounded on-disk receipt log for serve attempts (newest last). */
export class TailscaleServeReceiptStore {
  constructor(private readonly filePath: string) {}

  list(): TailscaleServeReceipt[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { receipts?: TailscaleServeReceipt[] };
      return Array.isArray(parsed.receipts) ? parsed.receipts : [];
    } catch {
      return [];
    }
  }

  append(receipt: TailscaleServeReceipt): void {
    const receipts = [...this.list(), receipt].slice(-MAX_RECEIPTS);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ receipts }, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('TailscaleServeReceiptStore: flush failed', { path: this.filePath, error: String(error) });
    }
  }

  latest(): TailscaleServeReceipt | null {
    const receipts = this.list();
    return receipts[receipts.length - 1] ?? null;
  }
}
