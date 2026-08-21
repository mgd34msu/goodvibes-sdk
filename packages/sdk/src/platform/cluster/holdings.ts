/**
 * holdings.ts, who currently holds what, derived from traffic alone.
 *
 * Spread ranking needs a number the whole cluster agrees on: how many surfaces
 * each node is already responsible for. There is no field on the wire that
 * carries it, and there deliberately isn't one, a node that ADVERTISED its own
 * load could advertise a convenient number, and every node would then be
 * ranking on a different node's self-report.
 *
 * It does not need one. Every node hears every datagram in the group: the
 * transport is multicast with loopback on, so a node that does not serve
 * Telegram still RECEIVES the Telegram heartbeats and can count them. Holdings
 * are therefore observed, not announced, each node counts, from the same
 * datagram stream, which node last claimed each surface. Two nodes that have
 * seen the same traffic compute the same numbers, including for themselves.
 *
 * Two separate tables, with different lifetimes:
 *
 *   holders   , surfaceId -> the node heard heartbeating it. Expires at the
 *                master timeout, because a holder that stopped heartbeating is
 *                exactly what "no longer holds it" looks like.
 *
 *   candidates, surfaceId -> nodes that have shown they can serve it, by
 *                sending ANY datagram for it. Expires much later: a standby is
 *                quiet by design, and forgetting it would make an overloaded
 *                holder believe it has nobody to hand a surface to.
 */

interface Entry {
  readonly nodeId: string;
  /** Monotonic reading when this was last confirmed. */
  seenMono: number;
}

export interface ClusterHoldingsOptions {
  /** How long a holder stays believed after its last heartbeat. */
  readonly holderTtlMs: number;
  /** How long a node stays a believed candidate after its last datagram. */
  readonly candidateTtlMs: number;
}

/** One observed holding, for `/status`. */
export interface ClusterHoldingRecord {
  readonly surfaceId: string;
  readonly nodeId: string;
}

export class ClusterHoldingsLedger {
  private readonly holders = new Map<string, Entry>();
  private readonly candidates = new Map<string, Map<string, Entry>>();

  constructor(private readonly options: ClusterHoldingsOptions) {}

  /** `nodeId` is heartbeating `surfaceId`, it holds it as of `mono`. */
  noteHolder(surfaceId: string, nodeId: string, mono: number): void {
    this.holders.set(surfaceId, { nodeId, seenMono: mono });
    this.noteCandidate(surfaceId, nodeId, mono);
  }

  /**
   * `nodeId` said it is no longer holding `surfaceId` (a RESIGN, or our own
   * ordered stop). Only clears the entry when that node is the believed holder
   *, a stale farewell from a node that already lost the surface must not
   * erase the successor.
   *
   * The node stays a CANDIDATE: resigning is not the same as being unable to
   * serve it, and a node that yields for balance is precisely the node we may
   * want to hand it back to later.
   */
  noteReleased(surfaceId: string, nodeId: string): void {
    if (this.holders.get(surfaceId)?.nodeId === nodeId) this.holders.delete(surfaceId);
  }

  /** `nodeId` spoke about `surfaceId`, so it can serve it. */
  noteCandidate(surfaceId: string, nodeId: string, mono: number): void {
    let perSurface = this.candidates.get(surfaceId);
    if (!perSurface) {
      perSurface = new Map<string, Entry>();
      this.candidates.set(surfaceId, perSurface);
    }
    const existing = perSurface.get(nodeId);
    if (existing) existing.seenMono = mono;
    else perSurface.set(nodeId, { nodeId, seenMono: mono });
  }

  /** The believed holder of `surfaceId`, or null when it has gone stale. */
  holderOf(surfaceId: string, mono: number): string | null {
    const entry = this.holders.get(surfaceId);
    if (!entry) return null;
    if (mono - entry.seenMono > this.options.holderTtlMs) {
      this.holders.delete(surfaceId);
      return null;
    }
    return entry.nodeId;
  }

  /**
   * How many surfaces `nodeId` currently holds, the spread ranking's second
   * tier, computed identically for self and for every peer.
   */
  holdingsOf(nodeId: string, mono: number): number {
    return this.surfacesHeldBy(nodeId, mono).length;
  }

  /** Which surfaces `nodeId` currently holds. */
  surfacesHeldBy(nodeId: string, mono: number): string[] {
    const held: string[] = [];
    for (const [surfaceId, entry] of [...this.holders]) {
      if (mono - entry.seenMono > this.options.holderTtlMs) {
        this.holders.delete(surfaceId);
        continue;
      }
      if (entry.nodeId === nodeId) held.push(surfaceId);
    }
    return held.sort();
  }

  /**
   * Nodes believed able to serve `surfaceId`, excluding `exceptNodeId`.
   *
   * `withinMs` narrows the answer to nodes heard from recently, and the yield
   * decision passes it deliberately. The table's own TTL is generous so a
   * standby that misses a beat is not forgotten; handing a working surface to
   * a node that may have died two beats ago needs a tighter bar than that, or
   * a machine that is switched off drags a surface offline for a full timeout
   * before its old holder takes it back.
   */
  candidatesFor(surfaceId: string, mono: number, exceptNodeId?: string, withinMs?: number): string[] {
    const perSurface = this.candidates.get(surfaceId);
    if (!perSurface) return [];
    const freshness = Math.min(withinMs ?? this.options.candidateTtlMs, this.options.candidateTtlMs);
    const alive: string[] = [];
    for (const [nodeId, entry] of [...perSurface]) {
      if (mono - entry.seenMono > this.options.candidateTtlMs) {
        perSurface.delete(nodeId);
        continue;
      }
      if (mono - entry.seenMono > freshness) continue;
      if (nodeId !== exceptNodeId) alive.push(nodeId);
    }
    if (perSurface.size === 0) this.candidates.delete(surfaceId);
    return alive.sort();
  }

  /**
   * Drop everything known about a node.
   *
   * Used when the local view has to be rebuilt from scratch, after a host
   * suspend, the holdings table describes a network that moved on without us,
   * and acting on it would rank against nodes that may no longer exist.
   */
  forgetAll(): void {
    this.holders.clear();
    this.candidates.clear();
  }

  /** Every live holding, for the `cluster` section of `/status`. */
  snapshot(mono: number): ClusterHoldingRecord[] {
    const records: ClusterHoldingRecord[] = [];
    for (const [surfaceId, entry] of [...this.holders]) {
      if (mono - entry.seenMono > this.options.holderTtlMs) {
        this.holders.delete(surfaceId);
        continue;
      }
      records.push({ surfaceId, nodeId: entry.nodeId });
    }
    return records.sort((a, b) => (a.surfaceId < b.surfaceId ? -1 : 1));
  }
}
