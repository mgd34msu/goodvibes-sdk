import type { DaemonBatchManager } from '../../batch/index.js';
import { DaemonBatchError } from '../../batch/index.js';
import type { CreateDaemonBatchJobInput } from '../../batch/types.js';
import { readBoundedPositiveInteger } from './route-helpers.js';

export interface DaemonBatchRouteContext {
  readonly batchManager: DaemonBatchManager;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
}

export async function dispatchBatchRoutes(
  req: Request,
  context: DaemonBatchRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if ((pathname === '/api/batch' || pathname === '/api/batch/config' || pathname === '/api/batch/runtime') && req.method === 'GET') {
    return Response.json(await context.batchManager.describeRuntime());
  }

  if (pathname === '/api/batch/jobs' && req.method === 'GET') {
    const limit = readBoundedPositiveInteger(url.searchParams.get('limit'), 100, 1_000);
    return Response.json({ jobs: await context.batchManager.listJobs(limit) });
  }

  if (pathname === '/api/batch/jobs' && req.method === 'POST') {
    const bodyOrErr = await context.parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleBatchError(async () => {
      const job = await context.batchManager.createJob(parseCreateJobInput(bodyOrErr));
      return Response.json({ job }, { status: 202 });
    });
  }

  const jobMatch = pathname.match(/^\/api\/batch\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    const job = await context.batchManager.getJob(decodeURIComponent(jobMatch[1]));
    if (!job) return Response.json({ error: 'Batch job not found', code: 'BATCH_JOB_NOT_FOUND' }, { status: 404 });
    return Response.json({ job });
  }

  const cancelMatch = pathname.match(/^\/api\/batch\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    return handleBatchError(async () => {
      const job = await context.batchManager.cancelJob(decodeURIComponent(cancelMatch[1]));
      return Response.json({ job });
    });
  }

  if (pathname === '/api/batch/tick' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    const body = bodyOrErr ?? {};
    return handleBatchError(async () => {
      const result = await context.batchManager.tick({ forceSubmit: body['force'] === true });
      return Response.json(result);
    });
  }

  return null;
}

async function handleBatchError(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof DaemonBatchError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: 'BATCH_ERROR' }, { status: 500 });
  }
}

function parseCreateJobInput(body: Record<string, unknown>): CreateDaemonBatchJobInput {
  const request = toRecord(body['request']);
  const source = toRecord(body['source']);
  const metadata = toStringRecord(body['metadata']);
  const input: CreateDaemonBatchJobInput = {
    ...(typeof body['provider'] === 'string' ? { provider: body['provider'] } : {}),
    ...(typeof body['model'] === 'string' ? { model: body['model'] } : {}),
    request: {
      messages: Array.isArray(request['messages']) ? request['messages'] as CreateDaemonBatchJobInput['request']['messages'] : [],
      ...(Array.isArray(request['tools']) ? { tools: request['tools'] as CreateDaemonBatchJobInput['request']['tools'] } : {}),
      ...(typeof request['systemPrompt'] === 'string' ? { systemPrompt: request['systemPrompt'] } : {}),
      ...(typeof request['maxTokens'] === 'number' ? { maxTokens: request['maxTokens'] } : {}),
      ...(request['reasoningEffort'] === 'instant' || request['reasoningEffort'] === 'low' || request['reasoningEffort'] === 'medium' || request['reasoningEffort'] === 'high'
        ? { reasoningEffort: request['reasoningEffort'] }
        : {}),
      ...(typeof request['reasoningSummary'] === 'boolean' ? { reasoningSummary: request['reasoningSummary'] } : {}),
    },
    ...(body['executionMode'] === 'batch' || body['executionMode'] === 'live' ? { executionMode: body['executionMode'] } : {}),
    ...(Object.keys(source).length > 0
      ? {
          source: {
            kind: parseSourceKind(source['kind']),
            ...(typeof source['id'] === 'string' ? { id: source['id'] } : {}),
          },
        }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(typeof body['flush'] === 'boolean' ? { flush: body['flush'] } : {}),
  };
  return input;
}

function parseSourceKind(value: unknown): NonNullable<CreateDaemonBatchJobInput['source']>['kind'] {
  if (
    value === 'daemon-api' ||
    value === 'cloudflare-worker' ||
    value === 'cloudflare-queue' ||
    value === 'automation' ||
    value === 'client'
  ) {
    return value;
  }
  return 'daemon-api';
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
