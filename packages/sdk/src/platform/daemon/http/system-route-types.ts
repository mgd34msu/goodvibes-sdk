import type { JsonRecord } from './route-helpers.js';
import type {
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  WatcherKind,
} from '@pellux/goodvibes-daemon-sdk';

export type {
  ApprovalBrokerLike,
  DaemonApiClientKind,
  DaemonSystemConfigManagerLike as ConfigManagerLike,
  DaemonSystemRouteContext,
  PlatformServiceManagerLike,
  RouteBindingManagerLike,
  WatcherRegistryLike,
  WorkspaceSwapManagerLike,
} from '@pellux/goodvibes-daemon-sdk';

export interface IntegrationApprovalSnapshotSourceLike {
  getApprovalSnapshot(): unknown;
}

export interface RouteBindingRecordInput {
  readonly id?: string | undefined;
  readonly kind: AutomationRouteBindingKind;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationSessionPolicy | undefined;
  readonly threadPolicy?: AutomationThreadPolicy | undefined;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface RouteBindingPatchInput {
  readonly sessionPolicy?: AutomationSessionPolicy | undefined;
  readonly threadPolicy?: AutomationThreadPolicy | undefined;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface WatcherSourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface WatcherRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: WatcherKind;
  readonly source: WatcherSourceRecord;
  readonly intervalMs?: number | undefined;
  readonly metadata: Record<string, unknown>;
}
