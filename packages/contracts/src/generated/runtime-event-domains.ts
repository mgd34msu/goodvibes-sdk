export const RUNTIME_EVENT_DOMAINS = [
  "session",
  "turn",
  "providers",
  "tools",
  "tasks",
  "agents",
  "workflows",
  "orchestration",
  "communication",
  "planner",
  "permissions",
  "plugins",
  "mcp",
  "transport",
  "compaction",
  "ui",
  "ops",
  "forensics",
  "security",
  "automation",
  "routes",
  "control-plane",
  "deliveries",
  "watchers",
  "surfaces",
  "knowledge",
  "workspace",
] as const;
export type RuntimeEventDomain = typeof RUNTIME_EVENT_DOMAINS[number];

/**
 * Minimal structural constraint for a runtime event record.
 * All concrete event types satisfy `{ readonly type: string }`.
 * Canonical home for this type — transport packages import from here.
 */
export type RuntimeEventRecord = { readonly type: string };

export function isRuntimeEventDomain(value: string): value is RuntimeEventDomain {
  return (RUNTIME_EVENT_DOMAINS as readonly string[]).includes(value);
}

