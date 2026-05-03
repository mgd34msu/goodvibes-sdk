import type { DaemonKnowledgeRefinementRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import type { DaemonKnowledgeRouteContext } from './knowledge-route-types.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readBoundedPositiveInteger,
  readOptionalStringField,
  readStringArrayField,
} from './route-helpers.js';

type KnowledgeRefinementRunBody = {
  readonly knowledgeSpaceId?: string;
  readonly gapIds?: string[];
  readonly sourceIds?: string[];
  readonly limit?: number;
  readonly force?: boolean;
};

export function createDaemonKnowledgeRefinementRouteHandlers(
  context: DaemonKnowledgeRouteContext,
): DaemonKnowledgeRefinementRouteHandlers {
  return {
    getKnowledgeRefinementTasks: (url) => Response.json({
      tasks: context.knowledgeService.listRefinementTasks(readLimit(url, 100), readRefinementTaskFilter(url)),
    }),
    getKnowledgeRefinementTask: (taskId) => {
      const task = context.knowledgeService.getRefinementTask(taskId);
      return task
        ? Response.json({ task })
        : jsonErrorResponse({ error: 'Unknown knowledge refinement task' }, { status: 404 });
    },
    postKnowledgeRunRefinement: async (request) => handleKnowledgeRunRefinement(context, request),
    postKnowledgeCancelRefinementTask: async (taskId, request) => handleKnowledgeCancelRefinementTask(context, taskId, request),
  };
}

function readLimit(url: URL, fallback: number): number {
  return readBoundedPositiveInteger(url.searchParams.get('limit'), fallback, 1_000);
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

const knowledgeRefinementBodySchemas = createRouteBodySchemaRegistry({
  run: createRouteBodySchema<KnowledgeRefinementRunBody>('POST /api/knowledge/refinement/run', (body) => {
    const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId') ?? readOptionalStringField(body, 'spaceId');
    const gapIds = readStringArrayField(body, 'gapIds');
    const sourceIds = readStringArrayField(body, 'sourceIds');
    return {
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(gapIds ? { gapIds } : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 1, 500) } : {}),
      ...(typeof body.force === 'boolean' ? { force: body.force } : {}),
    };
  }),
});

async function handleKnowledgeRunRefinement(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeRefinementBodySchemas.run.parse(body ?? {});
  if (input instanceof Response) return input;
  return Response.json(await context.knowledgeService.runRefinement(input));
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
    : jsonErrorResponse({ error: 'Unknown knowledge refinement task' }, { status: 404 });
}
