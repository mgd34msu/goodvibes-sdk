/**
 * checkin/briefing.ts
 *
 * Turns a state snapshot into the compact briefing the model judges. Pure and
 * deterministic so it is testable without any live services — the daemon binds
 * a CheckinStateReader to the real sessions/channels/automation, and this
 * renders whatever that reader returns.
 */
import type { CheckinStateSnapshot } from './types.js';

/** A one-line summary of the snapshot, reused in receipts. */
export function summarizeCheckinState(snapshot: CheckinStateSnapshot): string {
  return (
    `${snapshot.runningSessions} running, ${snapshot.blockedSessions} blocked, ` +
    `${snapshot.unreadChannelItems} unread, ${snapshot.recentCompletions} recent completions, ` +
    `${snapshot.needsAttention.length} needs-attention`
  );
}

/** The compact briefing text handed to the judge. */
export function assembleCheckinBriefing(snapshot: CheckinStateSnapshot): string {
  const lines: string[] = [
    'Current state:',
    `- Running sessions: ${snapshot.runningSessions}`,
    `- Blocked sessions: ${snapshot.blockedSessions}`,
    `- Unread channel items: ${snapshot.unreadChannelItems}`,
    `- Recent completions: ${snapshot.recentCompletions}`,
  ];
  if (snapshot.needsAttention.length > 0) {
    lines.push('- Needs attention:');
    for (const item of snapshot.needsAttention) lines.push(`  - ${item}`);
  } else {
    lines.push('- Needs attention: none');
  }
  return lines.join('\n');
}
