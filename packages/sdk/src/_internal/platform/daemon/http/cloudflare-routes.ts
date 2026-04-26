import { CloudflareControlPlaneManager } from '../../cloudflare/manager.js';
import { CloudflareControlPlaneError } from '../../cloudflare/types.js';
import type {
  CloudflareControlPlaneOptions,
  CloudflareDisableInput,
  CloudflareProvisionInput,
  CloudflareValidateInput,
  CloudflareVerifyInput,
} from '../../cloudflare/types.js';

export interface DaemonCloudflareRouteContext extends CloudflareControlPlaneOptions {
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
}

export async function dispatchCloudflareRoutes(
  req: Request,
  context: DaemonCloudflareRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (!pathname.startsWith('/api/cloudflare')) return null;

  const manager = new CloudflareControlPlaneManager(context);

  if ((pathname === '/api/cloudflare' || pathname === '/api/cloudflare/status') && req.method === 'GET') {
    return handleCloudflareError(async () => Response.json(await manager.describeStatus()));
  }

  if (pathname === '/api/cloudflare/validate' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.validate(parseValidateInput(bodyOrErr ?? {}))));
  }

  if (pathname === '/api/cloudflare/provision' && req.method === 'POST') {
    const bodyOrErr = await context.parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.provision(parseProvisionInput(bodyOrErr)), { status: 202 }));
  }

  if (pathname === '/api/cloudflare/verify' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.verify(parseVerifyInput(bodyOrErr ?? {}))));
  }

  if (pathname === '/api/cloudflare/disable' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.disable(parseDisableInput(bodyOrErr ?? {}))));
  }

  return null;
}

async function handleCloudflareError(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof CloudflareControlPlaneError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: 'CLOUDFLARE_ERROR' }, { status: 500 });
  }
}

function parseValidateInput(body: Record<string, unknown>): CloudflareValidateInput {
  return {
    ...(typeof body['accountId'] === 'string' ? { accountId: body['accountId'] } : {}),
    ...(typeof body['apiToken'] === 'string' ? { apiToken: body['apiToken'] } : {}),
    ...(typeof body['apiTokenRef'] === 'string' ? { apiTokenRef: body['apiTokenRef'] } : {}),
  };
}

function parseProvisionInput(body: Record<string, unknown>): CloudflareProvisionInput {
  return {
    ...parseValidateInput(body),
    ...(typeof body['workerName'] === 'string' ? { workerName: body['workerName'] } : {}),
    ...(typeof body['workerSubdomain'] === 'string' ? { workerSubdomain: body['workerSubdomain'] } : {}),
    ...(typeof body['workerBaseUrl'] === 'string' ? { workerBaseUrl: body['workerBaseUrl'] } : {}),
    ...(typeof body['daemonBaseUrl'] === 'string' ? { daemonBaseUrl: body['daemonBaseUrl'] } : {}),
    ...(typeof body['queueName'] === 'string' ? { queueName: body['queueName'] } : {}),
    ...(typeof body['deadLetterQueueName'] === 'string' ? { deadLetterQueueName: body['deadLetterQueueName'] } : {}),
    ...(typeof body['workerCron'] === 'string' ? { workerCron: body['workerCron'] } : {}),
    ...(typeof body['operatorToken'] === 'string' ? { operatorToken: body['operatorToken'] } : {}),
    ...(typeof body['operatorTokenRef'] === 'string' ? { operatorTokenRef: body['operatorTokenRef'] } : {}),
    ...(typeof body['workerClientToken'] === 'string' ? { workerClientToken: body['workerClientToken'] } : {}),
    ...(typeof body['workerClientTokenRef'] === 'string' ? { workerClientTokenRef: body['workerClientTokenRef'] } : {}),
    ...(typeof body['storeApiToken'] === 'boolean' ? { storeApiToken: body['storeApiToken'] } : {}),
    ...(typeof body['storeOperatorToken'] === 'boolean' ? { storeOperatorToken: body['storeOperatorToken'] } : {}),
    ...(typeof body['storeWorkerClientToken'] === 'boolean' ? { storeWorkerClientToken: body['storeWorkerClientToken'] } : {}),
    ...(typeof body['returnGeneratedSecrets'] === 'boolean' ? { returnGeneratedSecrets: body['returnGeneratedSecrets'] } : {}),
    ...(typeof body['enableWorkersDev'] === 'boolean' ? { enableWorkersDev: body['enableWorkersDev'] } : {}),
    ...(typeof body['queueJobPayloads'] === 'boolean' ? { queueJobPayloads: body['queueJobPayloads'] } : {}),
    ...(typeof body['verify'] === 'boolean' ? { verify: body['verify'] } : {}),
    ...(typeof body['persistConfig'] === 'boolean' ? { persistConfig: body['persistConfig'] } : {}),
    ...(body['batchMode'] === 'off' || body['batchMode'] === 'explicit' || body['batchMode'] === 'eligible-by-default'
      ? { batchMode: body['batchMode'] }
      : {}),
  };
}

function parseVerifyInput(body: Record<string, unknown>): CloudflareVerifyInput {
  return {
    ...(typeof body['workerBaseUrl'] === 'string' ? { workerBaseUrl: body['workerBaseUrl'] } : {}),
    ...(typeof body['workerClientToken'] === 'string' ? { workerClientToken: body['workerClientToken'] } : {}),
    ...(typeof body['workerClientTokenRef'] === 'string' ? { workerClientTokenRef: body['workerClientTokenRef'] } : {}),
  };
}

function parseDisableInput(body: Record<string, unknown>): CloudflareDisableInput {
  return {
    ...parseValidateInput(body),
    ...(typeof body['workerName'] === 'string' ? { workerName: body['workerName'] } : {}),
    ...(typeof body['disableWorkerSubdomain'] === 'boolean' ? { disableWorkerSubdomain: body['disableWorkerSubdomain'] } : {}),
    ...(typeof body['disableCron'] === 'boolean' ? { disableCron: body['disableCron'] } : {}),
    ...(typeof body['persistConfig'] === 'boolean' ? { persistConfig: body['persistConfig'] } : {}),
  };
}
