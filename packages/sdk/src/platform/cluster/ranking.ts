/**
 * ranking.ts, who should hold a surface, decided identically on every node.
 *
 * The ranking is per SURFACE, not per node, and it is total and deterministic:
 * given the same two candidates and the same surface, every node reaches the
 * same answer without talking to anyone. That is what lets a split-brain heal
 * without negotiation, both sides compute the same winner and the loser stands
 * down.
 *
 * Two orderings live here, and the difference between them matters.
 *
 * SPREAD ORDER (`compareSpreadRank`) decides contested elections:
 *   1. Newest version wins. A build that knows how to do something the other
 *      does not should be the one doing it, and this is also what makes an
 *      update roll over cleanly instead of leaving the old build in charge.
 *   2. FEWEST surfaces already held wins. This is what distributes work: a node
 *      already reading two surfaces should not also take the third while a
 *      second machine sits idle.
 *   3. Stable hash of (nodeId + surfaceId). Pseudo-random but fixed, and
 *      different per surface, so a genuine tie still splits surfaces across
 *      nodes instead of stacking them on whichever nodeId sorts lowest.
 *
 * Uptime is deliberately ABSENT. It was the second tier in the whole-node
 * design and it is exactly wrong for spread: the longest-lived node wins every
 * tiebreak, so it accumulates every surface and a freshly-booted second machine
 * never takes anything. Uptime survives only as a liveness signal, a node is
 * alive because it is heartbeating, not because it has been up a long time.
 *
 * STABLE ORDER (`compareStableRank`) drops the holdings tier and decides
 * anything that MUST resolve identically on both sides even when their views
 * disagree, chiefly two masters of one surface reconciling after a partition
 * heals. Holdings are observed from traffic, so two nodes can briefly hold
 * different counts; a reconciliation decided on a disputed number could have
 * both sides believing they lost, or both believing they won. Version and a
 * hash are computed from the datagram itself and can never disagree.
 */
import { stableSurfaceHash } from './surface-id.js';

/** The fields ranking reads from a message or a local snapshot. */
export interface ClusterRankable {
  readonly nodeId: string;
  readonly version: string;
}

/** A candidate plus its observed load. */
export interface ClusterSpreadRankable extends ClusterRankable {
  /** Surfaces this node is currently believed to hold. */
  readonly holdings: number;
}

/**
 * Compare two dotted numeric versions.
 *
 * Returns > 0 when `a` is newer, < 0 when `b` is newer, 0 when equal. Missing
 * components read as 0, so `1.2` and `1.2.0` are the same version. A
 * prerelease suffix (`1.2.0-rc.1`) is ordered BELOW the same release, matching
 * semver, because a release candidate must not preempt the release.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const length = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  // Equal release cores: a build WITHOUT a prerelease tag outranks one with.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === '') return 1;
  if (right.prerelease === '') return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

function splitVersion(raw: string): { release: number[]; prerelease: string } {
  const trimmed = String(raw ?? '').trim().replace(/^v/i, '');
  const buildStripped = trimmed.split('+')[0] ?? '';
  const dashIndex = buildStripped.indexOf('-');
  const core = dashIndex === -1 ? buildStripped : buildStripped.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? '' : buildStripped.slice(dashIndex + 1);
  const release = core
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    });
  return { release, prerelease };
}

/**
 * Version, then the per-surface stable hash, then nodeId.
 *
 * The nodeId is a last resort that can only be reached by a SHA-256 collision
 * on 256 bits; it is there so the ordering is provably total rather than
 * "total in practice".
 */
export function compareStableRank(a: ClusterRankable, b: ClusterRankable, surfaceId: string): number {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion > 0 ? -1 : 1;
  return compareHashThenId(a, b, surfaceId);
}

/** The full ruled ordering: version, then fewest holdings, then stable hash. */
export function compareSpreadRank(
  a: ClusterSpreadRankable,
  b: ClusterSpreadRankable,
  surfaceId: string,
): number {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion > 0 ? -1 : 1;
  if (a.holdings !== b.holdings) return a.holdings < b.holdings ? -1 : 1;
  return compareHashThenId(a, b, surfaceId);
}

function compareHashThenId(a: ClusterRankable, b: ClusterRankable, surfaceId: string): number {
  if (a.nodeId === b.nodeId) return 0;
  const hashA = stableSurfaceHash(a.nodeId, surfaceId);
  const hashB = stableSurfaceHash(b.nodeId, surfaceId);
  if (hashA !== hashB) return hashA < hashB ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : 1;
}

/** True when `candidate` should hold `surfaceId` rather than `incumbent`. */
export function outranksForSurface(
  candidate: ClusterSpreadRankable,
  incumbent: ClusterSpreadRankable,
  surfaceId: string,
): boolean {
  return compareSpreadRank(candidate, incumbent, surfaceId) < 0;
}

/** True under the holdings-free ordering. Used where both sides must agree. */
export function outranksStably(
  candidate: ClusterRankable,
  incumbent: ClusterRankable,
  surfaceId: string,
): boolean {
  return compareStableRank(candidate, incumbent, surfaceId) < 0;
}

/**
 * True when `candidate` carries a STRICTLY NEWER version than `incumbent`.
 *
 * This, and only this, authorizes preempting a node that is already
 * consuming a surface. Holdings and hashes decide who wins an election among
 * peers with nothing to consume yet; they are deliberately not grounds for
 * taking a surface away from a node that is already serving it, because that
 * would let the ranking interrupt a healthy holder every time the observed load
 * shifted. Rebalancing exists for that, and it goes through a voluntary yield.
 */
export function isStrictlyNewerVersion(candidate: ClusterRankable, incumbent: ClusterRankable): boolean {
  return compareVersions(candidate.version, incumbent.version) > 0;
}

/**
 * How far ahead a holder must be before it gives a surface up.
 *
 * TWO, not one, and this is the whole anti-oscillation argument. Yielding moves
 * one surface: the holder loses one and the taker gains one, so the gap closes
 * by exactly 2. From a gap of 2 the cluster lands on 0, balanced, and no
 * further yield triggers. From a gap of 1 it would land on -1, the new holder
 * would then be the overloaded one, and the pair would trade the same surface
 * back and forth forever.
 */
export const SURFACE_YIELD_GAP = 2;

/**
 * True when a holder should voluntarily release a surface to a lighter node.
 *
 * Voluntary is the operative word. Rebalancing never preempts a sitting holder
 * from the outside, the holder decides, and it releases through the ordinary
 * ordered stop-then-RESIGN path, so consumption stops before anything else
 * starts. An external preemption would have to interrupt a working consumer
 * from a node whose view of the load may be a heartbeat out of date.
 */
export function shouldYieldSurface(holderHoldings: number, candidateHoldings: number): boolean {
  return holderHoldings - candidateHoldings >= SURFACE_YIELD_GAP;
}
