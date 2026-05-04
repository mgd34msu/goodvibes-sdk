/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

export const EXECUTION_RISK_CLASSES = ['safe', 'elevated', 'dangerous'] as const;
export const EXECUTION_NETWORK_POLICIES = ['inherit', 'allow', 'deny', 'scoped'] as const;
export const EXECUTION_FILESYSTEM_POLICIES = ['inherit', 'workspace-write', 'read-only', 'isolated'] as const;

export type ExecutionRiskClass = typeof EXECUTION_RISK_CLASSES[number];
export type ExecutionNetworkPolicy = typeof EXECUTION_NETWORK_POLICIES[number];
export type ExecutionFilesystemPolicy = typeof EXECUTION_FILESYSTEM_POLICIES[number];

export interface ExecutionIntent {
  readonly riskClass?: ExecutionRiskClass | undefined;
  readonly requiresApproval?: boolean | undefined;
  readonly networkPolicy?: ExecutionNetworkPolicy | undefined;
  readonly filesystemPolicy?: ExecutionFilesystemPolicy | undefined;
}
