/**
 * ranking.ts — who should be responsible, decided identically on every node.
 *
 * The ranking is total and deterministic: given the same two candidates, every
 * node in the cluster reaches the same answer without talking to anyone. That
 * is what lets a split-brain heal without negotiation — both sides compute the
 * same winner and the loser stands down.
 *
 * Tiers, in order:
 *   1. Newest version wins. A build that knows how to do something the other
 *      does not should be the one doing it, and this is also what makes an
 *      update roll over cleanly instead of leaving the old build in charge.
 *   2. Longest uptime wins. Among equals, prefer the node that has already
 *      been stable — a flapping process should not repeatedly seize the role.
 *   3. Lexically lowest nodeId wins. Never a tie: nodeIds are unique.
 */
import type { ClusterMessage } from './types.js';

/** The fields ranking reads. Any message or local snapshot satisfies it. */
export type ClusterRankable = Pick<ClusterMessage, 'nodeId' | 'version' | 'uptimeMs'>;

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
 * Total order over candidates. Negative when `a` should be responsible,
 * positive when `b` should be, never 0 for two distinct nodes.
 */
export function compareRank(a: ClusterRankable, b: ClusterRankable): number {
  const byVersion = compareVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion > 0 ? -1 : 1;
  if (a.uptimeMs !== b.uptimeMs) return a.uptimeMs > b.uptimeMs ? -1 : 1;
  if (a.nodeId === b.nodeId) return 0;
  return a.nodeId < b.nodeId ? -1 : 1;
}

/** True when `candidate` outranks `incumbent` under the full ordering. */
export function outranks(candidate: ClusterRankable, incumbent: ClusterRankable): boolean {
  return compareRank(candidate, incumbent) < 0;
}

/**
 * True when `candidate` carries a STRICTLY NEWER version than `incumbent`.
 *
 * This — and only this — authorizes preemption of a sitting master. Uptime and
 * nodeId decide who wins an election among peers with nothing to consume yet;
 * they are deliberately not grounds for taking the role away from a node that
 * is already doing the work, because that would let a long-lived idle standby
 * repeatedly interrupt a healthy master for no gain.
 */
export function isStrictlyNewerVersion(candidate: ClusterRankable, incumbent: ClusterRankable): boolean {
  return compareVersions(candidate.version, incumbent.version) > 0;
}
