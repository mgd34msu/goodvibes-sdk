/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Post-phase bookkeeping failure classification.
 *
 * A pipeline phase's terminal verdict is decided by its GATE (phase-runner.ts
 * evaluateGate) and nothing else. Everything that happens AFTER the gate
 * passes — committing the scoped changes, merging the worktree, recording the
 * usage rollup — is BOOKKEEPING. The honesty rule this module encodes:
 *
 *   A bookkeeping failure surfaces as a WARNING on a PASSED item, never as an
 *   item failure — UNLESS it belongs to the NEGATING SET below.
 *
 * This mirrors SDK fc2cac0e's "keep a green chain green": a fully-passed WRFC
 * chain must not be flipped to FAILED by a non-fatal auto-commit fault. The
 * orchestration engine needs the same rule so a work item can never show
 * `failed` while every one of its phases shows `passed` and its scoped commit
 * landed — the contradictory state this module exists to make unrepresentable.
 *
 * ── The negating set (deliberately narrow, positive-evidence only) ──────────
 * A bookkeeping failure NEGATES the phase's passed work — and therefore fails
 * the item — only when it leaves the workspace in a state where the recorded
 * "passed" outcome can no longer be trusted:
 *
 *   • WORKSPACE / INDEX CORRUPTION — the commit or merge left git's index or
 *     working tree inconsistent (a held/locked index, an unmerged/conflicted
 *     tree, a broken or unreadable object, an unwritable ref/index) such that
 *     the item's changes are NEITHER cleanly recorded NOR cleanly reverted.
 *     Reporting "passed" on top of a corrupted workspace would be a lie, so
 *     this — and only this — flips the item to failed.
 *
 * Everything else is explicitly NON-negating (a warning on a passed item):
 *   • a commit that could not run at all (not a git repo, empty edit ledger,
 *     every candidate path was pre-existing launch-dirty residue),
 *   • a commit rejected by a pre-commit hook, or blocked by ordinary file
 *     permissions,
 *   • a merge that reported a no-op/failure without corrupting the tree,
 *   • any in-memory finalization error (usage rollup, result recording).
 * In each of these the gate already passed and the workspace is still
 * coherent, so the work stands and the fault is worth only a warning.
 *
 * Classification is CONSERVATIVE by design: a failure is treated as negating
 * only on POSITIVE evidence of corruption (a marker below). An unrecognised
 * error is non-negating — the bias is always to keep a genuinely-passed item
 * passed rather than to invent a failure.
 */

/**
 * Lower-cased substrings that positively identify workspace/index corruption.
 * Every entry is an unambiguous git-plumbing phrase for a tree/index/object
 * left in a broken state — not a phrase a routine hook rejection or permission
 * error would contain.
 */
const WORKSPACE_CORRUPTION_MARKERS: readonly string[] = [
  'index.lock',
  'unable to write new index',
  'index file corrupt',
  'unmerged',
  'cannot lock ref',
  'unable to write ref',
  'bad object',
  'loose object',
  'object file is empty',
  'corrupt',
];

export type BookkeepingFailureClass = 'negating' | 'non-negating';

/**
 * Classify a post-gate bookkeeping failure. Returns 'negating' only when the
 * error carries positive evidence of workspace/index corruption (see the
 * module doc's negating set); every other error — including an unrecognised
 * one — is 'non-negating' and must surface as a warning on a passed item.
 */
export function classifyBookkeepingFailure(error: unknown): BookkeepingFailureClass {
  const message = extractMessage(error).toLowerCase();
  return WORKSPACE_CORRUPTION_MARKERS.some((marker) => message.includes(marker))
    ? 'negating'
    : 'non-negating';
}

/** True iff the failure negates the phase's passed work (workspace corruption). */
export function isNegatingBookkeepingFailure(error: unknown): boolean {
  return classifyBookkeepingFailure(error) === 'negating';
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return String(error);
  }
}
