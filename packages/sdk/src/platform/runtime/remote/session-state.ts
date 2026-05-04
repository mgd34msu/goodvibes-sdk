import type { AcpConnection } from '../store/domains/acp.js';
import type { RemoteRunnerContract } from './types.js';
import type { RemoteCapabilitySnapshot } from './capabilities.js';
import type { RemoteHeartbeatSnapshot } from './heartbeat.js';
import type { RemoteRecoveryAction } from './recovery.js';
import type { RemoteNegotiationSnapshot } from './negotiation.js';

export interface RemoteSessionStateSnapshot {
  readonly runnerId: string;
  readonly label: string;
  readonly transportState: string;
  readonly taskId?: string | undefined;
  readonly messageCount: number;
  readonly errorCount: number;
  readonly lastError?: string | undefined;
  readonly heartbeat: RemoteHeartbeatSnapshot;
  readonly negotiation: RemoteNegotiationSnapshot;
  readonly capabilities: readonly RemoteCapabilitySnapshot[];
  readonly recovery: readonly RemoteRecoveryAction[];
}

export function buildRemoteSessionStateSnapshot(input: {
  runnerId: string;
  label: string;
  connection?: AcpConnection | null | undefined;
  contract?: RemoteRunnerContract | null | undefined;
  heartbeat: RemoteHeartbeatSnapshot;
  negotiation: RemoteNegotiationSnapshot;
  capabilities: readonly RemoteCapabilitySnapshot[];
  recovery: readonly RemoteRecoveryAction[];
}): RemoteSessionStateSnapshot {
  const { connection, contract } = input;
  return Object.freeze({
    runnerId: input.runnerId,
    label: input.label,
    transportState: connection?.transportState ?? contract?.transport.state ?? 'disconnected',
    ...(connection?.taskId ?? contract?.taskId ? { taskId: connection?.taskId ?? contract?.taskId } : {}),
    messageCount: connection?.messageCount ?? contract?.transport.messageCount ?? 0,
    errorCount: connection?.errorCount ?? contract?.transport.errorCount ?? 0,
    ...(connection?.lastError ?? contract?.transport.lastError
      ? { lastError: connection?.lastError ?? contract?.transport.lastError }
      : {}),
    heartbeat: input.heartbeat,
    negotiation: input.negotiation,
    capabilities: input.capabilities,
    recovery: input.recovery,
  });
}
