/**
 * headlines.ts — per-node headlines + the stall tell for the fleet read-model.
 *
 * OWNER'S LINE (the contract this module enforces): a headline that updates
 * when an agent moves to a new task is fine; a headline that constantly
 * streams new text is not. So:
 *
 *   - A node's headline is DERIVED from its task/phase identity only — never
 *     from tool chatter, output lines, or an agent's per-turn progress text.
 *     Same identity ⇒ the byte-identical headline object (same `updatedAt`),
 *     replaced in place on a transition. There is no API through which a
 *     caller can push arbitrary headline text, so no surface can turn the
 *     field into a feed.
 *   - The length cap is enforced HERE, at the read-model, not per surface.
 *
 * The stall tell is pure timestamp comparison: a live node whose last
 * observed activity is older than the threshold gains a quiet marker
 * (`since`, `quietForMs`) — no generated text, ever.
 */

import type { ProcessHeadline, ProcessNode, ProcessStallTell, ProcessState } from './types.js';

/** Read-model cap on headline text — enforced here so every surface inherits it. */
export const HEADLINE_MAX_CHARS = 80;

/** Default stall-tell threshold: a live node quiet this long gains the marker. */
export const DEFAULT_STALL_TELL_MS = 5 * 60_000;

/**
 * The task/phase identity a node's headline derives from — the ONLY input
 * that can change a headline. Agent nodes deliberately exclude their `phase`
 * activity (the orchestrator's per-turn `Turn N · Tool` progress line churns
 * every tool call — a feed, not a transition); orchestration/workflow nodes
 * include their phase activity text because it changes exactly at phase
 * transitions.
 */
export function headlineSource(node: ProcessNode): string | null {
  const base = (node.task ?? '').trim() || node.label.trim();
  if (base.length === 0) return null;
  const phaseText = node.kind !== 'agent' && node.currentActivity?.kind === 'phase'
    ? node.currentActivity.text.trim()
    : '';
  return phaseText.length > 0 ? `${base} — ${phaseText}` : base;
}

function truncateHeadline(text: string): string {
  if (text.length <= HEADLINE_MAX_CHARS) return text;
  return `${text.slice(0, HEADLINE_MAX_CHARS - 1)}…`;
}

interface HeadlineEntry {
  readonly sourceKey: string;
  readonly headline: ProcessHeadline;
}

/**
 * Registry-owned headline side-table. `derive` returns the EXISTING headline
 * object (byte-stable, same `updatedAt`) while the node's task/phase identity
 * is unchanged, and regenerates — replacing in place — only on a transition.
 */
export class HeadlineTable {
  private readonly entries = new Map<string, HeadlineEntry>();

  derive(node: ProcessNode, now: number): ProcessHeadline | undefined {
    const sourceKey = headlineSource(node);
    if (sourceKey === null) {
      this.entries.delete(node.id);
      return undefined;
    }
    const existing = this.entries.get(node.id);
    if (existing && existing.sourceKey === sourceKey) return existing.headline;
    const headline: ProcessHeadline = { text: truncateHeadline(sourceKey), updatedAt: now };
    this.entries.set(node.id, { sourceKey, headline });
    return headline;
  }

  /** Drop entries for nodes no longer present so the table cannot leak. */
  prune(liveNodeIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!liveNodeIds.has(id)) this.entries.delete(id);
    }
  }
}

/** States in which silence is meaningful — a terminal or parked node is not "quiet". */
const STALL_TELL_STATES: ReadonlySet<ProcessState> = new Set([
  'thinking',
  'executing-tool',
  'streaming',
  'retrying',
  'stalled',
]);

/**
 * Pure timestamp comparison: a live node whose last observed activity
 * (`currentActivity.at`, falling back to `startedAt`) is at least
 * `thresholdMs` old gains the quiet marker. No text is generated — surfaces
 * render the marker however they like.
 */
export function deriveStallTell(
  node: ProcessNode,
  now: number,
  thresholdMs: number,
): ProcessStallTell | undefined {
  if (!STALL_TELL_STATES.has(node.state)) return undefined;
  const lastActivityAt = node.currentActivity?.at ?? node.startedAt;
  if (lastActivityAt === undefined) return undefined;
  const quietForMs = now - lastActivityAt;
  if (quietForMs < thresholdMs) return undefined;
  return { since: lastActivityAt, quietForMs };
}
