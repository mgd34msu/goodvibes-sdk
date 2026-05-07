import type { ArtifactStoreUploadLike } from './artifact-upload.js';
import type { JsonRecord } from './route-helpers.js';

export type AutomationScheduleDefinition = unknown;
export type KnowledgeProjectionTargetKind = 'overview' | 'bundle' | 'source' | 'node' | 'issue' | 'dashboard' | 'rollup';
export type KnowledgeUsageKind = string;
export type KnowledgeCandidateStatus = string;
export type KnowledgeSourceType = string;
export type KnowledgePacketDetail = string;

export interface AuthenticatedPrincipalLike {
  readonly principalId: string;
  readonly principalKind: string;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

export interface KnowledgeGraphqlAccessLike {
  readonly requiredScopes: readonly string[];
  readonly adminRequired?: boolean | undefined;
}

export interface KnowledgeGraphqlResultLike {
  readonly data?: unknown | undefined;
  readonly errors?: readonly unknown[] | undefined;
}

export interface KnowledgeGraphqlServiceLike {
  readonly schemaText: string;
  execute(input: {
    readonly query: string;
    readonly operationName?: string | undefined;
    readonly variables?: Record<string, unknown> | undefined;
    readonly admin: boolean;
    readonly scopes: readonly string[];
  }): Promise<KnowledgeGraphqlResultLike>;
}

export interface KnowledgeServiceLike {
  getStatus(scope?: Record<string, unknown>): Promise<unknown>;
  querySources(input: Record<string, unknown>): { readonly total: number; readonly items: readonly unknown[] };
  queryNodes(input: Record<string, unknown>): { readonly total: number; readonly items: readonly unknown[] };
  queryIssues(input: Record<string, unknown>): { readonly total: number; readonly items: readonly unknown[] };
  reviewIssue(input: Record<string, unknown>): Promise<unknown>;
  getItemScoped(id: string, scope?: Record<string, unknown>): unknown | null;
  listConnectors(): readonly unknown[];
  getConnector(id: string): unknown | null;
  doctorConnector(id: string): Promise<unknown | null>;
  listProjectionTargets(limit: number, scope?: Record<string, unknown>): Promise<readonly unknown[]>;
  map(input: Record<string, unknown>): Promise<unknown>;
  listExtractions(limit: number, sourceId?: string, scope?: Record<string, unknown>): readonly unknown[];
  listUsageRecords(
    limit: number,
    filter: { targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: KnowledgeUsageKind },
  ): readonly unknown[];
  listConsolidationCandidates(
    limit: number,
    filter: { status?: KnowledgeCandidateStatus; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string },
  ): readonly unknown[];
  getConsolidationCandidate(id: string): unknown | null;
  listConsolidationReports(limit: number): readonly unknown[];
  getConsolidationReport(id: string): unknown | null;
  getExtraction(id: string): unknown | null;
  getSourceExtraction(id: string): unknown | null;
  listJobs(): readonly unknown[];
  getJob(jobId: string): unknown | null;
  listJobRuns(limit: number, jobId?: string): readonly unknown[];
  listRefinementTasks(limit: number, filter: Record<string, unknown>): readonly unknown[];
  getRefinementTask(id: string): unknown | null;
  runRefinement(input: Record<string, unknown>): Promise<unknown>;
  cancelRefinementTask(id: string): Promise<unknown | null>;
  listSchedules(limit: number): readonly unknown[];
  getSchedule(id: string): unknown | null;
  ingestUrl(input: Record<string, unknown>): Promise<unknown>;
  ingestArtifact(input: Record<string, unknown>): Promise<unknown>;
  syncBrowserHistory(input: Record<string, unknown>): Promise<unknown>;
  importBookmarksFromFile(input: Record<string, unknown>): Promise<unknown>;
  importUrlsFromFile(input: Record<string, unknown>): Promise<unknown>;
  ingestConnectorInput(input: Record<string, unknown>): Promise<unknown>;
  searchScoped(input: Record<string, unknown>): readonly unknown[];
  ask(input: Record<string, unknown>): Promise<unknown>;
  buildPacket(
    task: string,
    writeScope: readonly string[],
    limit: number,
    options: {
      detail?: KnowledgePacketDetail;
      budgetLimit?: number;
      knowledgeSpaceId?: string;
      includeAllSpaces?: boolean;
    },
  ): Promise<unknown> | unknown;
  decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: Record<string, unknown>,
  ): Promise<unknown>;
  runJob(jobId: string, input: Record<string, unknown>): Promise<unknown>;
  lint(): Promise<readonly unknown[]>;
  reindex(): Promise<unknown>;
  saveSchedule(input: {
    readonly id?: string | undefined;
    readonly jobId: string;
    readonly schedule: AutomationScheduleDefinition;
    readonly label?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<unknown>;
  deleteSchedule(id: string): Promise<boolean>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<unknown | null>;
  renderProjection(input: {
    kind: KnowledgeProjectionTargetKind;
    id?: string;
    limit?: number;
    knowledgeSpaceId?: string;
    includeAllSpaces?: boolean;
  }): Promise<unknown>;
  materializeProjection(input: {
    kind: KnowledgeProjectionTargetKind;
    id?: string | undefined;
    limit?: number | undefined;
    filename?: string | undefined;
    knowledgeSpaceId?: string | undefined;
    includeAllSpaces?: boolean | undefined;
  }): Promise<unknown>;
}

export interface DaemonKnowledgeRouteContext {
  readonly artifactStore: ArtifactStoreUploadLike;
  readonly configManager: { get(key: string): unknown };
  readonly inspectGraphqlAccess: (
    query: string,
    operationName?: string,
  ) => KnowledgeGraphqlAccessLike;
  readonly normalizeAtSchedule: (at: number) => AutomationScheduleDefinition;
  readonly normalizeCronSchedule: (
    expression: string,
    timezone?: string,
    staggerMs?: unknown,
  ) => AutomationScheduleDefinition;
  readonly normalizeEverySchedule: (
    interval: number | string,
    anchorAt?: number,
  ) => AutomationScheduleDefinition;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly parseJsonText: (raw: string) => JsonRecord | Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipalLike | null;
  readonly knowledgeService: KnowledgeServiceLike;
  readonly knowledgeGraphqlService: KnowledgeGraphqlServiceLike;
}
