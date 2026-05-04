import type { DaemonKnowledgeRouteHandlers } from './context.js';
import {
  buildMissingScopeBody,
  resolvePrivateHostFetchOptions,
} from './http-policy.js';
import { GoodVibesSdkError, DaemonErrorCategory } from '@pellux/goodvibes-errors';
import { jsonErrorResponse, summarizeErrorForRecord } from './error-response.js';
import { createArtifactFromUploadRequest, isArtifactUploadRequest } from './artifact-upload.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readBoundedPositiveInteger,
  readOptionalBoundedInteger,
  readOptionalStringField,
  readStringArrayField,
  type JsonRecord,
} from './route-helpers.js';
import { createDaemonKnowledgeRefinementRouteHandlers } from './knowledge-refinement-routes.js';
import type {
  AutomationScheduleDefinition,
  DaemonKnowledgeRouteContext,
  KnowledgeCandidateStatus,
  KnowledgePacketDetail,
  KnowledgeProjectionTargetKind,
  KnowledgeSourceType,
  KnowledgeUsageKind,
} from './knowledge-route-types.js';

type KnowledgeSearchBody = {
  readonly query: string;
  readonly limit: number;
};

type KnowledgeAskBody = {
  readonly query: string;
  readonly knowledgeSpaceId?: string | undefined;
  readonly limit?: number | undefined;
  readonly mode?: 'concise' | 'standard' | 'detailed' | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeConfidence?: boolean | undefined;
  readonly includeLinkedObjects?: boolean | undefined;
  readonly candidateSourceIds?: string[] | undefined;
  readonly candidateNodeIds?: string[] | undefined;
  readonly strictCandidates?: boolean | undefined;
};

type KnowledgePacketBody = {
  readonly task: string;
  readonly writeScope: string[];
  readonly limit: number;
  readonly detail?: KnowledgePacketDetail | undefined;
  readonly budgetLimit?: number | undefined;
};

type KnowledgeRunJobBody = {
  readonly mode?: 'inline' | 'background' | undefined;
  readonly sourceIds?: string[] | undefined;
  readonly limit?: number | undefined;
};

const MAX_KNOWLEDGE_INGEST_TAGS = 64;

export function createDaemonKnowledgeRouteHandlers(
  context: DaemonKnowledgeRouteContext,
): DaemonKnowledgeRouteHandlers {
  return {
    getKnowledgeStatus: async () => Response.json(await context.knowledgeService.getStatus()),
    getKnowledgeSources: async (url) => Response.json({ sources: context.knowledgeService.listSources(readLimit(url, 100)) }),
    getKnowledgeNodes: async (url) => Response.json({ nodes: context.knowledgeService.listNodes(readLimit(url, 100)) }),
    getKnowledgeIssues: async (url) => Response.json({ issues: context.knowledgeService.listIssues(readLimit(url, 100)) }),
    getKnowledgeItem: (id) => {
      const item = context.knowledgeService.getItem(id);
      return item
        ? Response.json(item)
        : jsonErrorResponse({ error: 'Unknown knowledge item' }, { status: 404 });
    },
    getKnowledgeConnectors: () => Response.json({ connectors: context.knowledgeService.listConnectors() }),
    getKnowledgeConnector: (id) => {
      const connector = context.knowledgeService.getConnector(id);
      return connector
        ? Response.json({ connector })
        : jsonErrorResponse({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeConnectorDoctor: async (id) => {
      const report = await context.knowledgeService.doctorConnector(id);
      return report
        ? Response.json({ report })
        : jsonErrorResponse({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeProjectionTargets: async (url) => Response.json({ targets: await context.knowledgeService.listProjectionTargets(readLimit(url, 25)) }),
    getKnowledgeMap: async (url) => Response.json(await context.knowledgeService.map({
      limit: readLimit(url, 500),
      includeSources: readBooleanQuery(url, 'includeSources'),
      includeIssues: readBooleanQuery(url, 'includeIssues'),
      includeGenerated: readBooleanQuery(url, 'includeGenerated'),
      ...readKnowledgeMapFilters(url),
    })),
    getKnowledgeGraphqlSchema: () => Response.json({
      language: 'graphql',
      domain: 'knowledge',
      schema: context.knowledgeGraphqlService.schemaText,
    }),
    getKnowledgeExtractions: async (url) => {
      const sourceId = url.searchParams.get('sourceId') ?? undefined;
      return Response.json({ extractions: context.knowledgeService.listExtractions(readLimit(url, 100), sourceId) });
    },
    getKnowledgeUsage: async (url) => {
      const targetKind = url.searchParams.get('targetKind') ?? undefined;
      const targetId = url.searchParams.get('targetId') ?? undefined;
      const usageKind = url.searchParams.get('usageKind') ?? undefined;
      return Response.json({
        usage: context.knowledgeService.listUsageRecords(readLimit(url, 100), {
          ...(targetKind ? { targetKind: targetKind as 'source' | 'node' | 'issue' } : {}),
          ...(targetId ? { targetId } : {}),
          ...(usageKind ? { usageKind: usageKind as KnowledgeUsageKind } : {}),
        }),
      });
    },
    getKnowledgeCandidates: async (url) => {
      const status = url.searchParams.get('status') ?? undefined;
      const subjectKind = url.searchParams.get('subjectKind') ?? undefined;
      const subjectId = url.searchParams.get('subjectId') ?? undefined;
      return Response.json({
        candidates: context.knowledgeService.listConsolidationCandidates(readLimit(url, 100), {
          ...(status ? { status: status as KnowledgeCandidateStatus } : {}),
          ...(subjectKind ? { subjectKind: subjectKind as 'source' | 'node' | 'issue' } : {}),
          ...(subjectId ? { subjectId } : {}),
        }),
      });
    },
    getKnowledgeCandidate: (id) => {
      const candidate = context.knowledgeService.getConsolidationCandidate(id);
      return candidate
        ? Response.json({ candidate })
        : jsonErrorResponse({ error: 'Unknown knowledge consolidation candidate' }, { status: 404 });
    },
    getKnowledgeReports: async (url) => Response.json({ reports: context.knowledgeService.listConsolidationReports(readLimit(url, 100)) }),
    getKnowledgeReport: (id) => {
      const report = context.knowledgeService.getConsolidationReport(id);
      return report
        ? Response.json({ report })
        : jsonErrorResponse({ error: 'Unknown knowledge consolidation report' }, { status: 404 });
    },
    getKnowledgeExtraction: (id) => {
      const extraction = context.knowledgeService.getExtraction(id);
      return extraction
        ? Response.json({ extraction })
        : jsonErrorResponse({ error: 'Unknown knowledge extraction' }, { status: 404 });
    },
    getKnowledgeSourceExtraction: (id) => {
      const extraction = context.knowledgeService.getSourceExtraction(id);
      return extraction
        ? Response.json({ extraction })
        : jsonErrorResponse({ error: 'Unknown source extraction' }, { status: 404 });
    },
    getKnowledgeJobs: () => Response.json({ jobs: context.knowledgeService.listJobs() }),
    getKnowledgeJob: (jobId) => {
      const job = context.knowledgeService.getJob(jobId);
      return job
        ? Response.json({ job })
        : jsonErrorResponse({ error: 'Unknown knowledge job' }, { status: 404 });
    },
    getKnowledgeJobRuns: (url) => {
      const jobId = url.searchParams.get('jobId') ?? undefined;
      return Response.json({ runs: context.knowledgeService.listJobRuns(readLimit(url, 25), jobId) });
    },
    ...createDaemonKnowledgeRefinementRouteHandlers(context),
    getKnowledgeSchedules: (url) => Response.json({ schedules: context.knowledgeService.listSchedules(readLimit(url, 100)) }),
    getKnowledgeSchedule: (id) => {
      const schedule = context.knowledgeService.getSchedule(id);
      return schedule
        ? Response.json({ schedule })
        : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeIngestUrl: async (request) => handleKnowledgeIngestUrl(context, request),
    postKnowledgeIngestArtifact: async (request) => handleKnowledgeIngestArtifact(context, request),
    postKnowledgeSyncBrowserHistory: async (request) => handleKnowledgeSyncBrowserHistory(context, request),
    postKnowledgeImportBookmarks: async (request) => handleKnowledgeImportBookmarks(context, request),
    postKnowledgeImportUrls: async (request) => handleKnowledgeImportUrls(context, request),
    postKnowledgeIngestConnector: async (request) => handleKnowledgeIngestConnector(context, request),
    postKnowledgeSearch: async (request) => handleKnowledgeSearch(context, request),
    postKnowledgeAsk: async (request) => handleKnowledgeAsk(context, request),
    postKnowledgePacket: async (request) => handleKnowledgePacket(context, request),
    postKnowledgeReviewIssue: async (id, request) => handleKnowledgeReviewIssue(context, id, request),
    postKnowledgeDecideCandidate: async (id, request) => handleKnowledgeDecideCandidate(context, id, request),
    postKnowledgeRunJob: async (jobId, request) => handleKnowledgeRunJob(context, jobId, request),
    postKnowledgeLint: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json({ issues: await context.knowledgeService.lint() });
    },
    postKnowledgeReindex: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(await context.knowledgeService.reindex());
    },
    postKnowledgeSaveSchedule: async (request) => handleKnowledgeSaveSchedule(context, request),
    deleteKnowledgeSchedule: async (id, request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      const deleted = await context.knowledgeService.deleteSchedule(id);
      return deleted
        ? Response.json({ deleted: true })
        : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeSetScheduleEnabled: async (id, request) => handleKnowledgeSetScheduleEnabled(context, id, request),
    postKnowledgeRenderProjection: async (request) => handleKnowledgeRenderProjection(context, request),
    postKnowledgeMaterializeProjection: async (request) => handleKnowledgeMaterializeProjection(context, request),
    executeKnowledgeGraphql: async (request) => handleKnowledgeGraphql(context, request),
  };
}

function readLimit(url: URL, fallback: number): number {
  return readBoundedPositiveInteger(url.searchParams.get('limit'), fallback, 1_000);
}

function readBooleanQuery(url: URL, key: string): boolean | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function readKnowledgeMapFilters(url: URL): JsonRecord {
  const minConfidence = readOptionalBoundedInteger(url.searchParams.get('minConfidence'), 0, 100);
  return {
    ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
    ...(Number.isFinite(minConfidence) ? { minConfidence } : {}),
    recordKinds: readStringList(url, 'recordKinds', 'recordKind'),
    ids: readStringList(url, 'ids', 'id'),
    linkedToIds: readStringList(url, 'linkedToIds', 'linkedToId'),
    nodeKinds: readStringList(url, 'nodeKinds', 'nodeKind'),
    sourceTypes: readStringList(url, 'sourceTypes', 'sourceType'),
    sourceStatuses: readStringList(url, 'sourceStatuses', 'sourceStatus'),
    nodeStatuses: readStringList(url, 'nodeStatuses', 'nodeStatus'),
    issueCodes: readStringList(url, 'issueCodes', 'issueCode'),
    issueStatuses: readStringList(url, 'issueStatuses', 'issueStatus'),
    issueSeverities: readStringList(url, 'issueSeverities', 'issueSeverity'),
    edgeRelations: readStringList(url, 'edgeRelations', 'edgeRelation'),
    tags: readStringList(url, 'tags', 'tag'),
  };
}

function readStringList(url: URL, ...names: readonly string[]): readonly string[] {
  return names
    .flatMap((name) => url.searchParams.getAll(name))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

const knowledgeBodySchemas = createRouteBodySchemaRegistry({
  search: createRouteBodySchema<KnowledgeSearchBody>('POST /api/knowledge/search', (body) => {
    const query = readOptionalStringField(body, 'query');
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    return {
      query,
      limit: readBoundedBodyInteger(body.limit, 10, 100),
    };
  }),
  ask: createRouteBodySchema<KnowledgeAskBody>('POST /api/knowledge/ask', (body) => {
    const query = readOptionalStringField(body, 'query');
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const mode = readKnowledgeAnswerMode(body.mode);
    const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId');
    const candidateSourceIds = readStringArrayField(body, 'candidateSourceIds');
    const candidateNodeIds = readStringArrayField(body, 'candidateNodeIds');
    return {
      query,
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 8, 50) } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof body.includeSources === 'boolean' ? { includeSources: body.includeSources } : {}),
      ...(typeof body.includeConfidence === 'boolean' ? { includeConfidence: body.includeConfidence } : {}),
      ...(typeof body.includeLinkedObjects === 'boolean' ? { includeLinkedObjects: body.includeLinkedObjects } : {}),
      ...(candidateSourceIds ? { candidateSourceIds } : {}),
      ...(candidateNodeIds ? { candidateNodeIds } : {}),
      ...(typeof body.strictCandidates === 'boolean' ? { strictCandidates: body.strictCandidates } : {}),
    };
  }),
  packet: createRouteBodySchema<KnowledgePacketBody>('POST /api/knowledge/packet', (body) => {
    const task = readOptionalStringField(body, 'task');
    if (!task) return jsonErrorResponse({ error: 'Missing task' }, { status: 400 });
    const detail = readKnowledgePacketDetail(body.detail);
    const budgetLimit = Object.hasOwn(body, 'budgetLimit')
      ? readBoundedBodyInteger(body.budgetLimit, 6, 100)
      : undefined;
    return {
      task,
      writeScope: readStringArrayField(body, 'writeScope') ?? [],
      limit: readBoundedBodyInteger(body.limit, 6, 50),
      ...(detail ? { detail } : {}),
      ...(typeof budgetLimit === 'number' ? { budgetLimit } : {}),
    };
  }),
  runJob: createRouteBodySchema<KnowledgeRunJobBody>('POST /api/knowledge/jobs/:jobId/run', (body) => {
    const mode = readKnowledgeJobRunMode(body.mode);
    const sourceIds = readStringArrayField(body, 'sourceIds');
    return {
      ...(mode ? { mode } : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 50, 500) } : {}),
    };
  }),
});

function readKnowledgeAnswerMode(value: unknown): 'concise' | 'standard' | 'detailed' | undefined {
  return value === 'concise' || value === 'standard' || value === 'detailed' ? value : undefined;
}

function readKnowledgePacketDetail(value: unknown): KnowledgePacketDetail | undefined {
  return typeof value === 'string' ? value.toLowerCase() as KnowledgePacketDetail : undefined;
}

function readKnowledgeJobRunMode(value: unknown): 'inline' | 'background' | undefined {
  return value === 'inline' || value === 'background' ? value : undefined;
}

function readKnowledgeProjectionRequest(
  body: JsonRecord,
): { kind: KnowledgeProjectionTargetKind; id?: string; limit?: number } | Response {
  const rawKind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (
    rawKind !== 'overview'
    && rawKind !== 'bundle'
    && rawKind !== 'source'
    && rawKind !== 'node'
    && rawKind !== 'issue'
    && rawKind !== 'dashboard'
    && rawKind !== 'rollup'
  ) {
    return jsonErrorResponse({
      error: 'Projection kind must be one of overview, bundle, source, node, issue, dashboard, or rollup.',
      code: 'INVALID_PROJECTION_KIND',
    }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if ((rawKind === 'source' || rawKind === 'node' || rawKind === 'issue' || rawKind === 'rollup') && !id) {
    return jsonErrorResponse({ error: `Projection kind ${rawKind} requires id.` }, { status: 400 });
  }
  return {
    kind: rawKind,
    ...(id ? { id } : {}),
    ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 20, 500) } : {}),
  };
}

function readKnowledgeSchedule(
  context: DaemonKnowledgeRouteContext,
  value: unknown,
): AutomationScheduleDefinition | Response {
  if (typeof value !== 'object' || value === null) {
    return jsonErrorResponse({ error: 'Missing schedule object' }, { status: 400 });
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === 'string' ? schedule.kind.trim().toLowerCase() : '';
  try {
    switch (kind) {
      case 'every':
        if (typeof schedule.intervalMs === 'number') {
          return context.normalizeEverySchedule(
            schedule.intervalMs,
            typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined,
          );
        }
        if (typeof schedule.interval === 'string') {
          return context.normalizeEverySchedule(
            schedule.interval,
            typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined,
          );
        }
        throw new GoodVibesSdkError('Invalid schedule: every schedule requires intervalMs or an interval object. Set schedule.intervalMs (number, in milliseconds) or schedule.interval.', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
      case 'cron':
        if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) {
          throw new GoodVibesSdkError('Invalid schedule: cron schedule requires a cron expression string in schedule.expression (e.g. "0 9 * * 1-5").', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
        }
        return context.normalizeCronSchedule(
          schedule.expression,
          typeof schedule.timezone === 'string' ? schedule.timezone : undefined,
          schedule.staggerMs,
        );
      case 'at':
        if (typeof schedule.at !== 'number') throw new GoodVibesSdkError('Invalid schedule: at schedule requires schedule.at as a Unix timestamp in milliseconds.', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
        return context.normalizeAtSchedule(schedule.at);
      default:
        throw new GoodVibesSdkError('Invalid schedule kind. Expected schedule.kind to be one of: "at", "every", or "cron".', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
    }
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

function readGraphqlVariables(
  value: unknown,
  parseJsonText: DaemonKnowledgeRouteContext['parseJsonText'],
): JsonRecord | Response | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const parsed = parseJsonText(value);
    if (parsed instanceof Response) return parsed;
    return parsed;
  }
  if (typeof value === 'object') {
    return value as JsonRecord;
  }
  return jsonErrorResponse({ error: 'GraphQL variables must be an object or JSON string.' }, { status: 400 });
}

async function parseKnowledgeGraphqlRequest(
  context: DaemonKnowledgeRouteContext,
  req: Request,
): Promise<{ query: string; operationName?: string; variables?: Record<string, unknown> } | Response> {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const query = url.searchParams.get('query')?.trim() ?? '';
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const variables = readGraphqlVariables(url.searchParams.get('variables'), context.parseJsonText);
    if (variables instanceof Response) return variables;
    const operationName = url.searchParams.get('operationName')?.trim();
    return {
      query,
      ...(operationName ? { operationName } : {}),
      ...(variables ? { variables } : {}),
    };
  }

  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.startsWith('application/graphql')) {
    const query = (await req.text()).trim();
    return query
      ? { query }
      : jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  }

  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  if (!body) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  const variables = readGraphqlVariables(body.variables, context.parseJsonText);
  if (variables instanceof Response) return variables;
  const operationName = typeof body.operationName === 'string' ? body.operationName.trim() : '';
  return {
    query,
    ...(operationName ? { operationName } : {}),
    ...(variables ? { variables } : {}),
  };
}

async function handleKnowledgeGraphql(context: DaemonKnowledgeRouteContext, req: Request): Promise<Response> {
  const parsed = await parseKnowledgeGraphqlRequest(context, req);
  if (parsed instanceof Response) return parsed;
  if (req.method === 'GET' && graphqlOperationLooksLikeMutation(parsed.query)) {
    return jsonErrorResponse({ error: 'GraphQL mutations must use POST.' }, { status: 405 });
  }
  const principal = context.resolveAuthenticatedPrincipal(req);
  if (!principal) {
    return jsonErrorResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  let access;
  try {
    access = context.inspectGraphqlAccess(parsed.query, parsed.operationName);
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }

  const scopeDenied = buildMissingScopeBody('knowledge GraphQL operation', access.requiredScopes, principal.scopes);
  if (scopeDenied) {
    return Response.json(scopeDenied, { status: 403 });
  }
  if (access.adminRequired && !principal.admin) {
    return jsonErrorResponse({ error: 'Knowledge GraphQL mutation requires admin access.' }, { status: 403 });
  }

  const result = await context.knowledgeGraphqlService.execute({
    query: parsed.query,
    ...(parsed.operationName ? { operationName: parsed.operationName } : {}),
    ...(parsed.variables ? { variables: parsed.variables } : {}),
    admin: principal.admin,
    scopes: principal.scopes,
  });
  const status = result.errors?.length && !result.data ? 400 : 200;
  return Response.json(result, { status });
}

function graphqlOperationLooksLikeMutation(query: string): boolean {
  const withoutComments = query.replace(/#[^\n\r]*/g, '');
  const withoutStrings = withoutComments
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
  return /^\s*mutation\b/.test(withoutStrings);
}

function buildKnowledgePrivateHostFetchOptions(
  context: DaemonKnowledgeRouteContext,
  requested: unknown,
): { allowPrivateHosts: true } | Record<string, never> | Response {
  return resolvePrivateHostFetchOptions(requested, {
    configManager: context.configManager,
  });
}

async function handleKnowledgeIngestUrl(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return jsonErrorResponse({ error: 'Missing url' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  const tags = readStringArrayField(body, 'tags', MAX_KNOWLEDGE_INGEST_TAGS);
  try {
    return Response.json(await context.knowledgeService.ingestUrl({
      url,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(tags ? { tags } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.sourceType === 'string' ? { sourceType: body.sourceType as KnowledgeSourceType } : {}),
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...(privateHostFetchOptions ?? {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeIngestArtifact(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;

  if (isArtifactUploadRequest(request)) {
    const uploaded = await createArtifactFromUploadRequest(context.artifactStore, request);
    if (uploaded instanceof Response) return uploaded;
    try {
      return Response.json(await context.knowledgeService.ingestArtifact({
        ...uploaded.fields,
        artifactId: uploaded.artifactId,
      }), { status: 201 });
    } catch (error) {
      return jsonErrorResponse(error, { status: 400 });
    }
  }

  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  const tags = readStringArrayField(body, 'tags', MAX_KNOWLEDGE_INGEST_TAGS);
  try {
    return Response.json(await context.knowledgeService.ingestArtifact({
      ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.uri === 'string' ? { uri: body.uri } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(tags ? { tags } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.sourceType === 'string' ? { sourceType: body.sourceType as KnowledgeSourceType } : {}),
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...(privateHostFetchOptions ?? {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeSyncBrowserHistory(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const input = body ?? {};
  const sourceKinds = Array.isArray(input.sourceKinds)
    ? input.sourceKinds.filter((entry): entry is string => entry === 'history' || entry === 'bookmark')
    : undefined;
  const browsers = Array.isArray(input.browsers)
    ? input.browsers.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  try {
    return Response.json(await context.knowledgeService.syncBrowserHistory({
      ...(Object.hasOwn(input, 'limit') ? { limit: readBoundedBodyInteger(input.limit, 50, 500) } : {}),
      ...(typeof input.sinceMs === 'number' ? { sinceMs: input.sinceMs } : {}),
      ...(typeof input.homeOverride === 'string' ? { homeOverride: input.homeOverride } : {}),
      ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
      ...(typeof input.connectorId === 'string' ? { connectorId: input.connectorId } : {}),
      ...(browsers?.length ? { browsers } : {}),
      ...(sourceKinds?.length ? { sourceKinds } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeImportBookmarks(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return jsonErrorResponse({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importBookmarksFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeImportUrls(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return jsonErrorResponse({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importUrlsFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeIngestConnector(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const connectorId = typeof body.connectorId === 'string' ? body.connectorId.trim() : '';
  if (!connectorId) return jsonErrorResponse({ error: 'Missing connectorId' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.ingestConnectorInput({
      connectorId,
      ...(Object.hasOwn(body, 'input') ? { input: body.input } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeSearch(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.search.parse(body);
  if (input instanceof Response) return input;
  return Response.json({ results: context.knowledgeService.search(input.query, input.limit) });
}

async function handleKnowledgeAsk(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.ask.parse(body);
  if (input instanceof Response) return input;
  return Response.json(await context.knowledgeService.ask(input));
}

async function handleKnowledgePacket(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.packet.parse(body);
  if (input instanceof Response) return input;
  return Response.json(await context.knowledgeService.buildPacket(input.task, input.writeScope, input.limit, {
    ...(input.detail ? { detail: input.detail } : {}),
    ...(typeof input.budgetLimit === 'number' ? { budgetLimit: input.budgetLimit } : {}),
  }));
}

async function handleKnowledgeReviewIssue(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';
  if (!['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'].includes(action)) {
    return jsonErrorResponse({ error: 'Action must be accept, reject, resolve, reopen, edit, or forget.' }, { status: 400 });
  }
  try {
    return Response.json(await context.knowledgeService.reviewIssue({
      issueId: id,
      action,
      ...(typeof body?.reviewer === 'string' ? { reviewer: body.reviewer } : {}),
      ...(body?.value && typeof body.value === 'object' && !Array.isArray(body.value) ? { value: body.value as Record<string, unknown> } : {}),
    }));
  } catch (error) {
    const message = summarizeErrorForRecord(error);
    return jsonErrorResponse(error, {
      status: message.startsWith('Unknown knowledge issue:') ? 404 : 400,
    });
  }
}

async function handleKnowledgeDecideCandidate(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  if (decision !== 'accept' && decision !== 'reject' && decision !== 'supersede') {
    return jsonErrorResponse({ error: 'Decision must be accept, reject, or supersede.' }, { status: 400 });
  }
  try {
    return Response.json({
      candidate: await context.knowledgeService.decideConsolidationCandidate(id, decision, {
        ...(typeof body.decidedBy === 'string' ? { decidedBy: body.decidedBy } : {}),
        ...(typeof body.memoryClass === 'string' ? { memoryClass: body.memoryClass } : {}),
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      }),
    });
  } catch (error) {
    const message = summarizeErrorForRecord(error);
    return jsonErrorResponse(error, {
      status: message.startsWith('Unknown knowledge consolidation candidate:') ? 404 : 400,
    });
  }
}

async function handleKnowledgeRunJob(context: DaemonKnowledgeRouteContext, jobId: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.runJob.parse(body);
  if (input instanceof Response) return input;
  try {
    return Response.json({
      run: await context.knowledgeService.runJob(jobId, input),
    });
  } catch (error) {
    const message = summarizeErrorForRecord(error);
    return jsonErrorResponse(error, {
      status: message.startsWith('Unknown knowledge job:') ? 404 : 400,
    });
  }
}

async function handleKnowledgeSaveSchedule(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  if (!jobId) return jsonErrorResponse({ error: 'Missing jobId' }, { status: 400 });
  const schedule = readKnowledgeSchedule(context, body.schedule);
  if (schedule instanceof Response) return schedule;
  try {
    return Response.json({
      schedule: await context.knowledgeService.saveSchedule({
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        jobId,
        schedule,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      }),
    }, { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeSetScheduleEnabled(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  if (typeof body.enabled !== 'boolean') {
    return jsonErrorResponse({ error: 'Missing enabled boolean' }, { status: 400 });
  }
  const schedule = await context.knowledgeService.setScheduleEnabled(id, body.enabled);
  return schedule
    ? Response.json({ schedule })
    : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
}

async function handleKnowledgeRenderProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  try {
    return Response.json(await context.knowledgeService.renderProjection(parsed));
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeMaterializeProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  try {
    return Response.json(await context.knowledgeService.materializeProjection({
      ...parsed,
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}


