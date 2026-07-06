import type { JsonRecord } from './route-helpers.js';
import type { RuntimeEventDomain } from '@pellux/goodvibes-contracts';

export type { RuntimeEventDomain };

export interface IntegrationRuntimeStoreLike {
  getState(): {
    readonly deliveries: {
      readonly deliveryAttempts: Map<string, unknown>;
    };
  };
}

export interface IntegrationHelperServiceLike {
  buildReview(): unknown;
  getSessionSnapshot(): unknown;
  getTaskSnapshot(): unknown;
  getAutomationSnapshot(): unknown;
  getSessionBrokerSnapshot(): unknown;
  getDeliverySnapshot(): unknown;
  getRouteSnapshot(): unknown;
  getRemoteSnapshot(): unknown;
  getHealthSnapshot(): unknown;
  getAccountsSnapshot(): Promise<unknown>;
  getSettingsSnapshot(): unknown;
  getSecuritySettingsReport(): unknown;
  getContinuitySnapshot(): unknown;
  getWorktreeSnapshot(): unknown;
  getIntelligenceSnapshot(): unknown;
  getLocalAuthSnapshot(): unknown;
  listPanels(): readonly unknown[];
  openPanel(panelId: string, pane: 'top' | 'bottom'): boolean;
  createEventStream(req: Request, domains: readonly RuntimeEventDomain[]): Response | Promise<Response>;
  getRuntimeStore(): IntegrationRuntimeStoreLike | null;
}

export interface ChannelAccountRegistryLike {
  listAccounts(): Promise<unknown[]>;
}

export interface ProviderRuntimeSnapshotServiceLike {
  listSnapshots(): Promise<readonly unknown[]>;
  getSnapshot(providerId: string): Promise<unknown | null>;
  getUsageSnapshot(providerId: string): Promise<unknown | null>;
}

/** A provenance link on a memory record, as carried on the wire. */
export interface MemoryProvenanceLinkInput {
  readonly kind: string;
  readonly ref: string;
  readonly label?: string | undefined;
}

/** The add-record body, structurally compatible with the SDK's MemoryAddOptions. */
export interface MemoryRecordAddInput {
  readonly cls: string;
  readonly summary: string;
  readonly scope?: string | undefined;
  readonly detail?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly provenance?: readonly MemoryProvenanceLinkInput[] | undefined;
  readonly review?: {
    readonly state?: string | undefined;
    readonly confidence?: number | undefined;
    readonly reviewedBy?: string | undefined;
    readonly staleReason?: string | undefined;
  } | undefined;
}

/** The search filter body, structurally compatible with the SDK's MemorySearchFilter. */
export interface MemoryRecordSearchFilterInput {
  readonly scope?: string | undefined;
  readonly cls?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly query?: string | undefined;
  readonly semantic?: boolean | undefined;
  readonly since?: number | undefined;
  readonly reviewState?: string | readonly string[] | undefined;
  readonly minConfidence?: number | undefined;
  readonly provenanceKinds?: readonly string[] | undefined;
  readonly staleOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

/** The review-update body, structurally compatible with the SDK's MemoryReviewPatch. */
export interface MemoryRecordReviewInput {
  readonly state?: string | undefined;
  readonly confidence?: number | undefined;
  readonly reviewedBy?: string | undefined;
  readonly staleReason?: string | undefined;
}

/**
 * The memory subsystem the daemon exposes to its routes. The concrete SDK
 * `MemoryRegistry` satisfies this structurally (method params are compared
 * bivariantly, exactly as `reviewQueue`'s `scope?: string` already binds to the
 * registry's `scope?: MemoryScope`). The route layer stays decoupled from the SDK
 * store types — it hands loose bodies in and serializes whatever comes back.
 */
export interface MemoryRegistryLike {
  doctor(): Promise<unknown>;
  vectorStats(): unknown;
  rebuildVectorsAsync(): Promise<unknown>;
  reviewQueue(limit?: number, scope?: string): unknown[];
  add(opts: MemoryRecordAddInput): Promise<unknown>;
  /**
   * Search honoring the recall-honesty contract; returns the honest envelope the
   * route serializes verbatim. `filter`/`options` are optional so the concrete
   * MemoryRegistry (whose defaults make BOTH params optional) binds bivariantly,
   * exactly as `reviewQueue`'s optional params already do.
   */
  honestSearch(filter?: MemoryRecordSearchFilterInput, options?: { readonly recall?: boolean | undefined }): unknown;
  get(id: string): unknown | null;
  review(id: string, patch: MemoryRecordReviewInput): unknown | null;
  delete(id: string): boolean;
}

export interface MemoryEmbeddingRegistryLike {
  setDefaultProvider(providerId: string): void;
}

export interface UserAuthManagerLike {
  addUser(username: string, password: string, roles: readonly string[]): unknown;
  deleteUser(username: string): boolean;
  rotatePassword(username: string, password: string): void;
  revokeSession(sessionId: string): boolean;
  clearBootstrapCredentialFile(): boolean;
}

export interface DaemonIntegrationRouteContext {
  readonly channelPlugins: ChannelAccountRegistryLike;
  readonly integrationHelpers: IntegrationHelperServiceLike | null;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingRegistryLike;
  readonly memoryRegistry: MemoryRegistryLike;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly providerRuntime: ProviderRuntimeSnapshotServiceLike;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly userAuth: UserAuthManagerLike;
}
