import type {
  ProjectPlanningDecisionRecordInput,
  ProjectPlanningEvaluateInput,
  ProjectPlanningLanguageUpsertInput,
  ProjectPlanningService,
  ProjectPlanningStateUpsertInput,
} from '../../knowledge/index.js';

type JsonRecord = Record<string, unknown>;

interface ProjectPlanningRouteContext {
  readonly projectPlanningService: ProjectPlanningService;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
}

export class ProjectPlanningRoutes {
  constructor(private readonly context: ProjectPlanningRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/projects/planning')) return null;
    try {
      if (url.pathname === '/api/projects/planning/status' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.status(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/state' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getState({
          ...readProjectSpaceFromUrl(url),
          planningId: url.searchParams.get('planningId') ?? undefined,
        }));
      }
      if (url.pathname === '/api/projects/planning/state' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.upsertState(await this.readBody<ProjectPlanningStateUpsertInput>(req)),
        ));
      }
      if (url.pathname === '/api/projects/planning/evaluate' && req.method === 'POST') {
        return Response.json(await this.context.projectPlanningService.evaluate(await this.readOptionalBody<ProjectPlanningEvaluateInput>(req)));
      }
      if (url.pathname === '/api/projects/planning/decisions' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.listDecisions(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/decisions' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.recordDecision(await this.readBody<ProjectPlanningDecisionRecordInput>(req)),
        ));
      }
      if (url.pathname === '/api/projects/planning/language' && req.method === 'GET') {
        return Response.json(await this.context.projectPlanningService.getLanguage(readProjectSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/projects/planning/language' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(
          await this.context.projectPlanningService.upsertLanguage(await this.readBody<ProjectPlanningLanguageUpsertInput>(req)),
        ));
      }
      return Response.json({ error: 'Unknown project planning route' }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  private async admin(req: Request, fn: () => Promise<Response>): Promise<Response> {
    const adminError = this.context.requireAdmin(req);
    if (adminError) return adminError;
    return fn();
  }

  private async readBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseJsonBody(req);
    if (body instanceof Response) throw new Error(await body.text());
    return body as T;
  }

  private async readOptionalBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseOptionalJsonBody(req);
    if (body instanceof Response) throw new Error(await body.text());
    return (body ?? {}) as T;
  }
}

function readProjectSpaceFromUrl(url: URL): JsonRecord {
  return {
    ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId')! } : {}),
    ...(url.searchParams.get('knowledgeSpaceId') ? { knowledgeSpaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
  };
}

