import type { ToolDefinition } from '../../types/tools.js';

export const REMOTE_TRIGGER_TOOL_SCHEMA: ToolDefinition = {
  name: 'remote',
  description: 'Manage remote runner pools, contracts, and portable artifacts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['create-pool', 'pools', 'assign', 'unassign', 'contracts', 'artifacts', 'review', 'import-artifact'] },
      view: { type: 'string', enum: ['summary', 'full'] },
      poolId: { type: 'string' },
      label: { type: 'string' },
      runnerId: { type: 'string' },
      artifactId: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface RemoteTriggerToolInput {
  readonly mode: 'create-pool' | 'pools' | 'assign' | 'unassign' | 'contracts' | 'artifacts' | 'review' | 'import-artifact';
  readonly view?: 'summary' | 'full' | undefined;
  readonly poolId?: string | undefined;
  readonly label?: string | undefined;
  readonly runnerId?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly path?: string | undefined;
}
