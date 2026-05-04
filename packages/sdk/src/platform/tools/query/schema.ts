import type { ToolDefinition } from '../../types/tools.js';

export const QUERY_TOOL_SCHEMA: ToolDefinition = {
  name: 'query',
  description: 'Track operator queries, answers, escalation, and closure.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['ask', 'list', 'show', 'answer', 'close'] },
      view: { type: 'string', enum: ['summary', 'full'] },
      queryId: { type: 'string' },
      prompt: { type: 'string' },
      askedBy: { type: 'string' },
      target: { type: 'string' },
      answer: { type: 'string' },
      resolution: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface QueryToolInput {
  readonly mode: 'ask' | 'list' | 'show' | 'answer' | 'close';
  readonly view?: 'summary' | 'full' | undefined;
  readonly queryId?: string | undefined;
  readonly prompt?: string | undefined;
  readonly askedBy?: string | undefined;
  readonly target?: string | undefined;
  readonly answer?: string | undefined;
  readonly resolution?: string | undefined;
}
