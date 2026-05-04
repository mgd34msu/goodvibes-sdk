/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export const TASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'list', 'show', 'status', 'depend', 'cancel', 'handoff', 'handoffs'],
    },
    view: { type: 'string', enum: ['summary', 'full'] },
    sessionId: { type: 'string' },
    taskId: { type: 'string' },
    title: { type: 'string' },
    label: { type: 'string' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
    },
    dependsOnSessionId: { type: 'string' },
    dependsOnTaskId: { type: 'string' },
    reason: { type: 'string' },
    toSessionId: { type: 'string' },
    scope: {
      type: 'string',
      enum: ['task', 'subtree', 'session'],
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

export type TaskToolInput = {
  mode: 'create' | 'list' | 'show' | 'status' | 'depend' | 'cancel' | 'handoff' | 'handoffs';
  view?: 'summary' | 'full' | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  title?: string | undefined;
  label?: string | undefined;
  status?: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | undefined;
  dependsOnSessionId?: string | undefined;
  dependsOnTaskId?: string | undefined;
  reason?: string | undefined;
  toSessionId?: string | undefined;
  scope?: 'task' | 'subtree' | 'session' | undefined;
};
