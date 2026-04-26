import { CloudflareControlPlaneManager } from '../../cloudflare/manager.js';
import { CloudflareControlPlaneError } from '../../cloudflare/types.js';
import type {
  CloudflareControlPlaneOptions,
  CloudflareDiscoverInput,
  CloudflareDisableInput,
  CloudflareOperationalTokenInput,
  CloudflareProvisionInput,
  CloudflareTokenRequirementsInput,
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

  if (pathname === '/api/cloudflare/token/requirements' && req.method === 'GET') {
    const components = parseComponentsFromSearch(url.searchParams);
    return handleCloudflareError(async () => Response.json(manager.tokenRequirements({ components, includeBootstrap: url.searchParams.get('bootstrap') === 'true' })));
  }

  if (pathname === '/api/cloudflare/token/requirements' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(manager.tokenRequirements(parseTokenRequirementsInput(bodyOrErr ?? {}))));
  }

  if (pathname === '/api/cloudflare/token/create' && req.method === 'POST') {
    const bodyOrErr = await context.parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.createOperationalToken(parseOperationalTokenInput(bodyOrErr)), { status: 201 }));
  }

  if (pathname === '/api/cloudflare/discover' && req.method === 'POST') {
    const bodyOrErr = await context.parseOptionalJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return handleCloudflareError(async () => Response.json(await manager.discover(parseDiscoverInput(bodyOrErr ?? {}))));
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
    ...(parseComponents(body) ? { components: parseComponents(body) } : {}),
    ...(typeof body['workerName'] === 'string' ? { workerName: body['workerName'] } : {}),
    ...(typeof body['workerSubdomain'] === 'string' ? { workerSubdomain: body['workerSubdomain'] } : {}),
    ...(typeof body['workerHostname'] === 'string' ? { workerHostname: body['workerHostname'] } : {}),
    ...(typeof body['workerBaseUrl'] === 'string' ? { workerBaseUrl: body['workerBaseUrl'] } : {}),
    ...(typeof body['daemonBaseUrl'] === 'string' ? { daemonBaseUrl: body['daemonBaseUrl'] } : {}),
    ...(typeof body['daemonHostname'] === 'string' ? { daemonHostname: body['daemonHostname'] } : {}),
    ...(typeof body['zoneId'] === 'string' ? { zoneId: body['zoneId'] } : {}),
    ...(typeof body['zoneName'] === 'string' ? { zoneName: body['zoneName'] } : {}),
    ...(typeof body['queueName'] === 'string' ? { queueName: body['queueName'] } : {}),
    ...(typeof body['deadLetterQueueName'] === 'string' ? { deadLetterQueueName: body['deadLetterQueueName'] } : {}),
    ...(typeof body['tunnelName'] === 'string' ? { tunnelName: body['tunnelName'] } : {}),
    ...(typeof body['tunnelId'] === 'string' ? { tunnelId: body['tunnelId'] } : {}),
    ...(typeof body['tunnelServiceUrl'] === 'string' ? { tunnelServiceUrl: body['tunnelServiceUrl'] } : {}),
    ...(typeof body['tunnelTokenRef'] === 'string' ? { tunnelTokenRef: body['tunnelTokenRef'] } : {}),
    ...(typeof body['accessAppId'] === 'string' ? { accessAppId: body['accessAppId'] } : {}),
    ...(typeof body['accessServiceTokenId'] === 'string' ? { accessServiceTokenId: body['accessServiceTokenId'] } : {}),
    ...(typeof body['accessServiceTokenRef'] === 'string' ? { accessServiceTokenRef: body['accessServiceTokenRef'] } : {}),
    ...(typeof body['kvNamespaceName'] === 'string' ? { kvNamespaceName: body['kvNamespaceName'] } : {}),
    ...(typeof body['kvNamespaceId'] === 'string' ? { kvNamespaceId: body['kvNamespaceId'] } : {}),
    ...(typeof body['durableObjectNamespaceName'] === 'string' ? { durableObjectNamespaceName: body['durableObjectNamespaceName'] } : {}),
    ...(typeof body['durableObjectNamespaceId'] === 'string' ? { durableObjectNamespaceId: body['durableObjectNamespaceId'] } : {}),
    ...(typeof body['r2BucketName'] === 'string' ? { r2BucketName: body['r2BucketName'] } : {}),
    ...(typeof body['secretsStoreName'] === 'string' ? { secretsStoreName: body['secretsStoreName'] } : {}),
    ...(typeof body['secretsStoreId'] === 'string' ? { secretsStoreId: body['secretsStoreId'] } : {}),
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

function parseTokenRequirementsInput(body: Record<string, unknown>): CloudflareTokenRequirementsInput {
  return {
    ...(parseComponents(body) ? { components: parseComponents(body) } : {}),
    ...(typeof body['includeBootstrap'] === 'boolean' ? { includeBootstrap: body['includeBootstrap'] } : {}),
  };
}

function parseOperationalTokenInput(body: Record<string, unknown>): CloudflareOperationalTokenInput {
  return {
    ...parseTokenRequirementsInput(body),
    ...(typeof body['accountId'] === 'string' ? { accountId: body['accountId'] } : {}),
    ...(typeof body['zoneId'] === 'string' ? { zoneId: body['zoneId'] } : {}),
    ...(typeof body['zoneName'] === 'string' ? { zoneName: body['zoneName'] } : {}),
    ...(typeof body['bootstrapToken'] === 'string' ? { bootstrapToken: body['bootstrapToken'] } : {}),
    ...(typeof body['tokenName'] === 'string' ? { tokenName: body['tokenName'] } : {}),
    ...(typeof body['expiresOn'] === 'string' ? { expiresOn: body['expiresOn'] } : {}),
    ...(typeof body['persistConfig'] === 'boolean' ? { persistConfig: body['persistConfig'] } : {}),
    ...(typeof body['storeApiToken'] === 'boolean' ? { storeApiToken: body['storeApiToken'] } : {}),
    ...(typeof body['returnGeneratedToken'] === 'boolean' ? { returnGeneratedToken: body['returnGeneratedToken'] } : {}),
  };
}

function parseDiscoverInput(body: Record<string, unknown>): CloudflareDiscoverInput {
  return {
    ...parseValidateInput(body),
    ...(parseComponents(body) ? { components: parseComponents(body) } : {}),
    ...(typeof body['zoneId'] === 'string' ? { zoneId: body['zoneId'] } : {}),
    ...(typeof body['zoneName'] === 'string' ? { zoneName: body['zoneName'] } : {}),
    ...(typeof body['includeResources'] === 'boolean' ? { includeResources: body['includeResources'] } : {}),
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

function parseComponents(body: Record<string, unknown>): CloudflareProvisionInput['components'] | undefined {
  const value = body['components'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    ...(typeof input['workers'] === 'boolean' ? { workers: input['workers'] } : {}),
    ...(typeof input['queues'] === 'boolean' ? { queues: input['queues'] } : {}),
    ...(typeof input['zeroTrustTunnel'] === 'boolean' ? { zeroTrustTunnel: input['zeroTrustTunnel'] } : {}),
    ...(typeof input['zeroTrustAccess'] === 'boolean' ? { zeroTrustAccess: input['zeroTrustAccess'] } : {}),
    ...(typeof input['dns'] === 'boolean' ? { dns: input['dns'] } : {}),
    ...(typeof input['kv'] === 'boolean' ? { kv: input['kv'] } : {}),
    ...(typeof input['durableObjects'] === 'boolean' ? { durableObjects: input['durableObjects'] } : {}),
    ...(typeof input['secretsStore'] === 'boolean' ? { secretsStore: input['secretsStore'] } : {}),
    ...(typeof input['r2'] === 'boolean' ? { r2: input['r2'] } : {}),
  };
}

function parseComponentsFromSearch(params: URLSearchParams): CloudflareProvisionInput['components'] | undefined {
  const body: Record<string, unknown> = {};
  const components: Record<string, unknown> = {};
  for (const key of ['workers', 'queues', 'zeroTrustTunnel', 'zeroTrustAccess', 'dns', 'kv', 'durableObjects', 'secretsStore', 'r2']) {
    const value = params.get(key);
    if (value === 'true') components[key] = true;
    if (value === 'false') components[key] = false;
  }
  if (Object.keys(components).length === 0) return undefined;
  body['components'] = components;
  return parseComponents(body);
}
