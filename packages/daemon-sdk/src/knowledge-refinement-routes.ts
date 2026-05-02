import type { DaemonApiRouteHandlers } from './context.js';
import type { DaemonKnowledgeRouteContext } from './knowledge-route-types.js';

export function createDaemonKnowledgeRefinementRouteHandlers(
  context: DaemonKnowledgeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getKnowledgeRefinementTasks'
  | 'getKnowledgeRefinementTask'
  | 'postKnowledgeRunRefinement'
  | 'postKnowledgeCancelRefinementTask'
> {
  return {
    getKnowledgeRefinementTasks: (url) => Response.json({
      tasks: context.knowledgeService.listRefinementTasks(readLimit(url, 100), readRefinementTaskFilter(url)),
    }),
    getKnowledgeRefinementTask: (taskId) => {
      const task = context.knowledgeService.getRefinementTask(taskId);
      return task
        ? Response.json({ task })
        : Response.json({ error: 'Unknown knowledge refinement task' }, { status: 404 });
    },
    postKnowledgeRunRefinement: async (request) => handleKnowledgeRunRefinement(context, request),
    postKnowledgeCancelRefinementTask: async (taskId, request) => handleKnowledgeCancelRefinementTask(context, taskId, request),
  };
}

function readLimit(url: URL, fallback: number): number {
  return readBoundedPositiveInteger(url.searchParams.get('limit'), fallback, 1_000);
}

function readBoundedPositiveInteger(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function readRefinementTaskFilter(url: URL): Record<string, unknown> {
  return {
    ...(url.searchParams.get('spaceId') ? { spaceId: url.searchParams.get('spaceId')! } : {}),
    ...(url.searchParams.get('knowledgeSpaceId') ? { spaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
    ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
    ...(url.searchParams.get('subjectKind') ? { subjectKind: url.searchParams.get('subjectKind')! } : {}),
    ...(url.searchParams.get('subjectId') ? { subjectId: url.searchParams.get('subjectId')! } : {}),
    ...(url.searchParams.get('gapId') ? { gapId: url.searchParams.get('gapId')! } : {}),
  };
}

async function handleKnowledgeRunRefinement(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const input = body ?? {};
  return Response.json(await context.knowledgeService.runRefinement({
    ...(typeof input.knowledgeSpaceId === 'string' ? { knowledgeSpaceId: input.knowledgeSpaceId } : {}),
    ...(typeof input.spaceId === 'string' ? { knowledgeSpaceId: input.spaceId } : {}),
    ...(Array.isArray(input.gapIds) ? { gapIds: input.gapIds.filter(isString) } : {}),
    ...(Array.isArray(input.sourceIds) ? { sourceIds: input.sourceIds.filter(isString) } : {}),
    ...(typeof input.limit === 'number' ? { limit: Math.max(1, input.limit) } : {}),
    ...(typeof input.force === 'boolean' ? { force: input.force } : {}),
  }));
}

async function handleKnowledgeCancelRefinementTask(
  context: DaemonKnowledgeRouteContext,
  taskId: string,
  request: Request,
): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const task = await context.knowledgeService.cancelRefinementTask(taskId);
  return task
    ? Response.json({ task })
    : Response.json({ error: 'Unknown knowledge refinement task' }, { status: 404 });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
