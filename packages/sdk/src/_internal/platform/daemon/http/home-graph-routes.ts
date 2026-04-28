import type { HomeGraphService } from '../../knowledge/index.js';
import type {
  HomeGraphAskInput,
  HomeGraphExport,
  HomeGraphIngestArtifactInput,
  HomeGraphIngestNoteInput,
  HomeGraphIngestUrlInput,
  HomeGraphLinkInput,
  HomeGraphProjectionInput,
  HomeGraphReviewInput,
  HomeGraphSnapshotInput,
} from '../../knowledge/index.js';

type JsonRecord = Record<string, unknown>;

interface HomeGraphRouteContext {
  readonly homeGraphService: HomeGraphService;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
}

export class HomeGraphRoutes {
  constructor(private readonly context: HomeGraphRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/homeassistant/home-graph')) return null;
    try {
      if (url.pathname === '/api/homeassistant/home-graph/status' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.status(readSpaceFromUrl(url)));
      }
      if (url.pathname === '/api/homeassistant/home-graph/issues' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listIssues({
          ...readSpaceFromUrl(url),
          status: url.searchParams.get('status') ?? undefined,
          severity: url.searchParams.get('severity') ?? undefined,
          code: url.searchParams.get('code') ?? undefined,
          limit: readLimit(url, 100),
        }));
      }
      if (url.pathname === '/api/homeassistant/home-graph/sources' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listSources({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 100),
        }));
      }
      if (url.pathname === '/api/homeassistant/home-graph/browse' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.browse({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 250),
        }));
      }
      if (url.pathname === '/api/homeassistant/home-graph/export' && req.method === 'POST') {
        return Response.json(await this.context.homeGraphService.exportSpace(await this.readOptionalBody(req)));
      }
      if (url.pathname === '/api/homeassistant/home-graph/ask' && req.method === 'POST') {
        return Response.json(await this.context.homeGraphService.ask(await this.readBody<HomeGraphAskInput>(req)));
      }
      if (url.pathname === '/api/homeassistant/home-graph/sync' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.syncSnapshot(await this.readBody<HomeGraphSnapshotInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/ingest/url' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.ingestUrl(await this.readBody<HomeGraphIngestUrlInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/ingest/note' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.ingestNote(await this.readBody<HomeGraphIngestNoteInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/ingest/artifact' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.ingestArtifact(await this.readBody<HomeGraphIngestArtifactInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/link' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.linkKnowledge(await this.readBody<HomeGraphLinkInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/unlink' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.unlinkKnowledge(await this.readBody<HomeGraphLinkInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/device-passport' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.refreshDevicePassport(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/room-page' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.generateRoomPage(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/packet' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.generatePacket(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/facts/review' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.reviewFact(await this.readBody<HomeGraphReviewInput>(req))));
      }
      if (url.pathname === '/api/homeassistant/home-graph/import' && req.method === 'POST') {
        return this.admin(req, async () => Response.json(await this.context.homeGraphService.importSpace(await this.readBody<HomeGraphSpaceImportInput>(req))));
      }
      return Response.json({ error: 'Unknown Home Graph route' }, { status: 404 });
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

  private async readOptionalBody(req: Request): Promise<JsonRecord> {
    const body = await this.context.parseOptionalJsonBody(req);
    if (body instanceof Response) throw new Error(await body.text());
    return body ?? {};
  }
}

type HomeGraphSpaceImportInput = {
  readonly installationId?: string;
  readonly knowledgeSpaceId?: string;
  readonly data: HomeGraphExport;
};

function readSpaceFromUrl(url: URL): JsonRecord {
  return {
    ...(url.searchParams.get('installationId') ? { installationId: url.searchParams.get('installationId')! } : {}),
    ...(url.searchParams.get('knowledgeSpaceId') ? { knowledgeSpaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
  };
}

function readLimit(url: URL, fallback: number): number {
  const parsed = Number(url.searchParams.get('limit') ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}
