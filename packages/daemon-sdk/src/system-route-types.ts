import type { JsonRecord } from './route-helpers.js';

export type DaemonApiClientKind =
  | 'web'
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix'
  | 'daemon';

export type AutomationRouteBindingKind = string;
export type AutomationSurfaceKind = string;
export type AutomationSessionPolicy = string;
export type AutomationThreadPolicy = string;
export type AutomationDeliveryGuarantee = string;
export type WatcherKind = string;

export interface ConfigManagerLike {
  get(key: string): unknown;
  getAll(): Record<string, unknown>;
  setDynamic(key: string, value: unknown): void;
}

export interface IntegrationApprovalSnapshotSourceLike {
  getApprovalSnapshot(): unknown;
}

export interface PlatformServiceManagerLike {
  status(): Record<string, unknown>;
  install(): unknown;
  start(): unknown;
  stop(): unknown;
  restart(): unknown;
  uninstall(): unknown;
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

export interface RouteBindingManagerLike {
  listBindings(): readonly unknown[];
  upsertBinding(input: RouteBindingRecordInput): Promise<unknown>;
  patchBinding(bindingId: string, input: RouteBindingPatchInput): Promise<unknown | null>;
  removeBinding(bindingId: string): Promise<boolean>;
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

export interface WatcherRegistryLike {
  list(): readonly unknown[];
  removeWatcher(watcherId: string): boolean;
  registerWatcher(input: {
    readonly id: string;
    readonly label: string;
    readonly kind: WatcherKind;
    readonly source: WatcherSourceRecord;
    readonly intervalMs: number;
    readonly metadata: Record<string, unknown>;
    readonly run?: (() => string) | undefined | undefined;
  }): WatcherRecord;
  getWatcher(watcherId: string): WatcherRecord | null;
  startWatcher(watcherId: string): WatcherRecord | null;
  stopWatcher(watcherId: string, reason: string): WatcherRecord | null;
  runWatcherNow(watcherId: string): Promise<WatcherRecord | null>;
}

export interface ApprovalBrokerLike {
  claimApproval(approvalId: string, actor: string, actorSurface: string, note?: string): Promise<unknown | null>;
  cancelApproval(approvalId: string, actor: string, actorSurface: string, note?: string): Promise<unknown | null>;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember: boolean;
      readonly actor: string;
      readonly actorSurface: string;
      readonly note?: string | undefined;
    },
  ): Promise<unknown | null>;
}

export interface WorkspaceSwapManagerLike {
  getCurrentWorkingDir(): string;
  requestSwap(newWorkingDir: string): Promise<
    | { ok: true; previous: string; current: string }
    | { ok: false; code: 'WORKSPACE_BUSY'; reason: string; retryAfter: number }
    | { ok: false; code: 'INVALID_PATH'; reason: string }
  >;
}

export interface DaemonSystemRouteContext {
  readonly approvalBroker: ApprovalBrokerLike;
  readonly configManager: ConfigManagerLike;
  readonly integrationHelpers: IntegrationApprovalSnapshotSourceLike | null;
  readonly inspectInboundTls: (surface: 'controlPlane' | 'httpListener') => unknown;
  readonly inspectOutboundTls: () => unknown;
  readonly isValidConfigKey: (key: string) => boolean;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly platformServiceManager: PlatformServiceManagerLike;
  readonly recordApiResponse: (
    req: Request,
    path: string,
    response: Response,
    clientKind?: DaemonApiClientKind,
  ) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly routeBindings: RouteBindingManagerLike;
  /** Manages runtime.workingDir swaps. Null when workspace swapping is not available. */
  readonly swapManager: WorkspaceSwapManagerLike | null;
  readonly watcherRegistry: WatcherRegistryLike;
}
