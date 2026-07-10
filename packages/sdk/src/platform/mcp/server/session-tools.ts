/**
 * mcp/server/session-tools.ts
 *
 * The session lifecycle operator methods the MCP server surfaces as first-class
 * tools, so an external agent tool can drive a GoodVibes session end to end:
 * create a session, attach to it, send it a message, read its transcript, and
 * steer a live turn. These are ordinary cataloged operator methods — this file
 * just names the lifecycle subset and its intent so the generator can lift them
 * to the front of the tool list and give each a task-oriented hint.
 */

/** A named step in the session lifecycle, mapped to the operator method that performs it. */
export interface SessionLifecycleTool {
  /** The session-driving intent this method serves. */
  readonly intent: 'create' | 'attach' | 'send-message' | 'read-transcript' | 'steer';
  /** The cataloged operator method id. */
  readonly methodId: string;
  /** A one-line, task-oriented hint layered on top of the catalog description. */
  readonly hint: string;
}

/**
 * The ordered session lifecycle. Order is meaningful: it is the natural
 * sequence an agent follows, and the generator preserves it at the front of the
 * emitted tool list.
 */
export const SESSION_LIFECYCLE_TOOLS: readonly SessionLifecycleTool[] = [
  {
    intent: 'create',
    methodId: 'sessions.create',
    hint: 'Start a new GoodVibes session to drive.',
  },
  {
    intent: 'attach',
    methodId: 'sessions.get',
    hint: 'Attach to an existing session by id to read its current state.',
  },
  {
    intent: 'send-message',
    methodId: 'sessions.messages.create',
    hint: 'Send a message (a turn of input) to a session.',
  },
  {
    intent: 'read-transcript',
    methodId: 'sessions.messages.list',
    hint: 'Read a session transcript: its ordered messages.',
  },
  {
    intent: 'steer',
    methodId: 'sessions.steer',
    hint: 'Steer a live, in-progress turn with an out-of-band instruction.',
  },
];

/** The lifecycle method ids, in lifecycle order. */
export const SESSION_LIFECYCLE_METHOD_IDS: readonly string[] = SESSION_LIFECYCLE_TOOLS.map(
  (tool) => tool.methodId,
);

const LIFECYCLE_BY_METHOD_ID: ReadonlyMap<string, SessionLifecycleTool> = new Map(
  SESSION_LIFECYCLE_TOOLS.map((tool) => [tool.methodId, tool]),
);

/** Whether a method id is one of the first-class session lifecycle tools. */
export function isSessionLifecycleMethodId(methodId: string): boolean {
  return LIFECYCLE_BY_METHOD_ID.has(methodId);
}

/** The lifecycle descriptor for a method id, or undefined when it is not a lifecycle method. */
export function sessionLifecycleToolFor(methodId: string): SessionLifecycleTool | undefined {
  return LIFECYCLE_BY_METHOD_ID.get(methodId);
}

/** The lifecycle order rank of a method id (lower is earlier); Infinity when not a lifecycle method. */
export function sessionLifecycleRank(methodId: string): number {
  const index = SESSION_LIFECYCLE_METHOD_IDS.indexOf(methodId);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}
