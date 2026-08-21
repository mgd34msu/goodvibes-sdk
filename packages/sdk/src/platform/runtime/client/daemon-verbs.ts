/**
 * daemon-verbs.ts, the socket every client seam plugs into, and nothing else.
 *
 * ── Why the resolution is NOT here ─────────────────────────────────────────
 *
 * Every module in this directory needs the same two things from its product:
 * "can a daemon be reached right now, and if not, why not", and "invoke this
 * verb". It does NOT need to know how the product decided which daemon that is.
 * Resolving a base URL, deciding whether the daemon is enabled at all, and
 * proving this surface may call it are consumer trust-boundary concerns, the
 * SDK core deliberately never reaches into them, and that carve-out is recorded
 * beside the spine transports.
 *
 * So the SDK owns the SHAPE and the product owns the PLUG: a terminal app
 * resolves a loopback file token, a chat host resolves a paired bearer, and both
 * hand the same two-method object to every seam below. A seam under test is
 * handed a fake and never reaches a real port.
 *
 * ── Refusals are values ────────────────────────────────────────────────────
 *
 * `probe()` returns the refusal rather than throwing it, because a caller uses
 * it to print an honest line instead of crashing a keystroke. `invoke()` is the
 * opposite: once a call is actually made, a failure is a failure and it throws.
 * A seam that wants to degrade instead of failing calls `probe()` first, every
 * module in this directory does exactly that, and each one documents which of
 * its operations degrade and which refuse.
 */

/**
 * Whether a daemon is reachable in principle, with the honest reason when it is
 * not.
 *
 * A product's richer resolution result, one that also carries the resolved
 * client on the available branch, satisfies this structurally, so no adapter
 * is needed to pass one in.
 */
export type DaemonReachability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * A verb caller bound to one product's connection resolution: the shape every
 * client seam in this directory takes.
 */
export interface DaemonVerbCaller {
  /** Whether a daemon is reachable in principle, with the honest reason when not. */
  probe(): DaemonReachability;
  /**
   * Invoke a verb. Throws on a non-2xx, and on "no daemon is configured at all"
   *, a seam that wants to degrade instead of failing calls `probe()` first.
   */
  invoke<T = unknown>(methodId: string, input?: unknown): Promise<T>;
}
