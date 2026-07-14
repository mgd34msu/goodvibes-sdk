/**
 * control-plane/sse-timing.ts
 *
 * ONE source of truth for the server-sent-events keep-alive timing, so the two
 * numbers that must never drift apart — the heartbeat interval and the server's
 * idle timeout — are derived from each other instead of being independent magic
 * literals.
 *
 * The failure this prevents: Bun.serve's default idleTimeout is 10s, but the SSE
 * heartbeat interval is 15s, so a quiet stream is torn down ~5s BEFORE its first
 * keep-alive frame ever arrives. Deriving the idle timeout from the heartbeat
 * interval (and firing the first heartbeat immediately on open) makes a quiet
 * stream survive indefinitely.
 */

/** The SSE keep-alive heartbeat interval (ms). The gateway fires one immediately on open, then on this cadence. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The server idle timeout (seconds, Bun.serve's unit) that comfortably exceeds
 * a heartbeat interval: 2x the interval plus a slack margin, so even a single
 * dropped/late heartbeat cannot trip the idle cutoff. Clamped to Bun's valid
 * 1..255s range. Derived from the interval — never a second independent number.
 */
export function sseIdleTimeoutSeconds(heartbeatIntervalMs: number = SSE_HEARTBEAT_INTERVAL_MS): number {
  const SLACK_MS = 5_000;
  const derivedMs = heartbeatIntervalMs * 2 + SLACK_MS;
  const seconds = Math.ceil(derivedMs / 1_000);
  return Math.min(255, Math.max(1, seconds));
}
