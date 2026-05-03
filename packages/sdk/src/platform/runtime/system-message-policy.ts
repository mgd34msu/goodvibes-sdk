/**
 * Host-neutral system-message routing policy helpers.
 *
 * These helpers decide message kind, default targets, and delivery shape.
 * Actual wiring into conversations, panels, or other host surfaces stays
 * outside the SDK.
 */

export type SystemMessagePriorityLevel = 'high' | 'low';
export type SystemMessageKind = 'system' | 'operational' | 'wrfc';
export type SystemMessageTarget = 'conversation' | 'panel' | 'both';

const HIGH_PRIORITY_RE =
  /\bfatal\b|\bcrash\w*|\bunhandled exception\b|\[Model\]|\[Provider\].*switch|\[Session\].*(?:saved|loaded|restored)|\[Compaction\]|\[Recovery\].*Failed/i;

export function classifySystemMessagePriority(message: string): SystemMessagePriorityLevel {
  return HIGH_PRIORITY_RE.test(message) ? 'high' : 'low';
}

export function defaultSystemMessageTarget(kind: SystemMessageKind): SystemMessageTarget {
  if (kind === 'wrfc') return 'both';
  return 'panel';
}

export function classifySystemMessageKind(message: string): SystemMessageKind {
  if (/^\[WRFC\]/i.test(message)) return 'wrfc';
  if (/^\[(Scan|Local|Agents|MCP|Plugin|Hook|Tool|Exec|Remote|Bridge|Approval)\]/i.test(message)) {
    return 'operational';
  }
  return 'system';
}

export function resolveSystemMessageDelivery(
  target: SystemMessageTarget,
  hasPanel: boolean,
): { readonly toPanel: boolean; readonly toConversation: boolean } {
  if (target === 'both') {
    return { toPanel: hasPanel, toConversation: true };
  }
  if (target === 'conversation') {
    return { toPanel: false, toConversation: true };
  }
  return hasPanel
    ? { toPanel: true, toConversation: false }
    : { toPanel: false, toConversation: true };
}
