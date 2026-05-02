// Synced from packages/daemon-sdk/src/remote-routes.ts
import type { DaemonApiRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import { serializableJsonResponse } from './route-helpers.js';

type JsonBody = Record<string, unknown>;
type RemotePeerAuth = unknown;
const MAX_REMOTE_RESULT_BYTES = 1_000_000;
const MAX_REMOTE_PAYLOAD_BYTES = 1_000_000;

interface DistributedRuntimeRouteService {
  listPairRequests(): unknown;
  approvePairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  rejectPairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listPeers(): unknown;
  rotatePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  revokePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  disconnectPeer(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listWork(): unknown;
  invokePeer(input: Record<string, unknown>): Promise<unknown>;
  cancelWork(workId: string, input: Record<string, unknown>): Promise<unknown | null>;
  getNodeHostContract(): unknown;
  requestPairing(input: Record<string, unknown>): Promise<unknown>;
  verifyPairRequest(requestId: string, challenge: string, input: Record<string, unknown>): Promise<unknown | null>;
  heartbeatPeer(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  claimWork(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  completeWork(auth: RemotePeerAuth, workId: string, input: Record<string, unknown>): Promise<unknown | null>;
}

interface SessionUserLike {
  readonly username: string;
}

interface DaemonRemoteRouteContext {
  readonly authToken?: string | null;
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<RemotePeerAuth | Response>;
  readonly requireAuthenticatedSession: (req: Request) => SessionUserLike | null;
  readonly distributedRuntime: DistributedRuntimeRouteService;
}

export function createDaemonRemoteRouteHandlers(
  context: DaemonRemoteRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getRemotePairRequests'
  | 'approveRemotePairRequest'
  | 'rejectRemotePairRequest'
  | 'getRemotePeers'
  | 'rotateRemotePeerToken'
  | 'revokeRemotePeerToken'
  | 'disconnectRemotePeer'
  | 'getRemoteWork'
  | 'invokeRemotePeer'
  | 'cancelRemoteWork'
  | 'getRemoteNodeHostContract'
> {
  return {
    getRemotePairRequests: () => Response.json({ requests: context.distributedRuntime.listPairRequests() }),
    approveRemotePairRequest: async (requestId, request) => handleApproveRemotePairRequest(context, requestId, request),
    rejectRemotePairRequest: async (requestId, request) => handleRejectRemotePairRequest(context, requestId, request),
    getRemotePeers: () => Response.json({ peers: context.distributedRuntime.listPeers() }),
    rotateRemotePeerToken: async (peerId, request) => handleRotateRemotePeerToken(context, peerId, request),
    revokeRemotePeerToken: async (peerId, request) => handleRevokeRemotePeerToken(context, peerId, request),
    disconnectRemotePeer: async (peerId, request) => handleDisconnectRemotePeer(context, peerId, request),
    getRemoteWork: () => Response.json({ work: context.distributedRuntime.listWork() }),
    invokeRemotePeer: async (peerId, request) => handleInvokeRemotePeer(context, peerId, request),
    cancelRemoteWork: async (workId, request) => handleCancelRemoteWork(context, workId, request),
    getRemoteNodeHostContract: () => serializableJsonResponse({ contract: context.distributedRuntime.getNodeHostContract() }),
  };
}

export async function handleRemotePairRequest(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peerKind = body.peerKind === 'device' ? 'device' : 'node';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    return Response.json({ error: 'Missing remote peer label' }, { status: 400 });
  }
  const created = await context.distributedRuntime.requestPairing({
    peerKind,
    requestedId: typeof body.requestedId === 'string' ? body.requestedId : undefined,
    label,
    platform: typeof body.platform === 'string' ? body.platform : undefined,
    deviceFamily: typeof body.deviceFamily === 'string' ? body.deviceFamily : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    clientMode: typeof body.clientMode === 'string' ? body.clientMode : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === 'string') : [],
    commands: Array.isArray(body.commands) ? body.commands.filter((value): value is string => typeof value === 'string') : [],
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    requestedBy: 'remote',
    remoteAddress: readForwardedForForDisplay(req),
    ttlMs: boundedPositiveNumber(body.ttlMs, 1_000, 86_400_000),
  });
  return Response.json(created, { status: 201 });
}

export async function handleRemotePairVerify(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const challenge = typeof body.challenge === 'string' ? body.challenge : '';
  if (!requestId || !challenge) {
    return Response.json({ error: 'Missing requestId or challenge' }, { status: 400 });
  }
  const verified = await context.distributedRuntime.verifyPairRequest(requestId, challenge, {
    remoteAddress: readForwardedForForDisplay(req),
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return verified
    ? Response.json(verified)
    : Response.json({ error: 'Pair request not approved, expired, or invalid' }, { status: 404 });
}

export async function handleRemotePeerHeartbeat(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:heartbeat');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.heartbeatPeer(auth, {
    remoteAddress: readForwardedForForDisplay(req),
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === 'string') : undefined,
    commands: Array.isArray(body.commands) ? body.commands.filter((value): value is string => typeof value === 'string') : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    clientMode: typeof body.clientMode === 'string' ? body.clientMode : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return Response.json({ peer });
}

export async function handleRemotePeerWorkPull(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:pull');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const work = await context.distributedRuntime.claimWork(auth, {
    maxItems: boundedPositiveNumber(body.maxItems, 1, 100),
    leaseMs: boundedPositiveNumber(body.leaseMs, 1_000, 3_600_000),
  });
  return Response.json({ work });
}

export async function handleRemotePeerWorkComplete(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  workId: string,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:complete');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const result = validateRemoteJsonPayload(body.result, MAX_REMOTE_RESULT_BYTES, 'result');
  if (result instanceof Response) return result;
  const work = await context.distributedRuntime.completeWork(auth, workId, {
    status: body.status === 'failed' || body.status === 'cancelled' ? body.status : body.status === 'completed' ? 'completed' : undefined,
    result,
    error: typeof body.error === 'string' ? body.error : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return work
    ? Response.json({ work })
    : Response.json({ error: 'Unknown or unclaimed remote work item' }, { status: 404 });
}

function boundedPositiveNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateRemoteJsonPayload(value: unknown, maxBytes: number, field: string): unknown | Response {
  const encoded = new TextEncoder().encode(JSON.stringify(value ?? null));
  if (encoded.byteLength <= maxBytes) return value;
  return Response.json({
    error: `Remote ${field} exceeds ${maxBytes} byte limit`,
  }, { status: 413 });
}

function readForwardedForForDisplay(req: Request): string | undefined {
  // x-forwarded-for is caller-controlled unless the daemon is explicitly behind
  // a trusted proxy. Preserve a small display/audit hint, but never use it for
  // authorization decisions.
  const value = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return value || undefined;
}

function operatorActor(context: DaemonRemoteRouteContext, req: Request): string {
  return context.authToken ? 'shared-token' : context.requireAuthenticatedSession(req)?.username ?? 'operator';
}

async function handleApproveRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const approved = await context.distributedRuntime.approvePairRequest(requestId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
    label: typeof body.label === 'string' ? body.label : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });
  return approved
    ? Response.json(approved)
    : Response.json({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRejectRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const rejected = await context.distributedRuntime.rejectPairRequest(requestId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
  });
  return rejected
    ? Response.json(rejected)
    : Response.json({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRotateRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const rotated = await context.distributedRuntime.rotatePeerToken(peerId, {
    actor: operatorActor(context, req),
    label: typeof body.label === 'string' ? body.label : undefined,
    scopes: Array.isArray(body.scopes) ? body.scopes.filter((value): value is string => typeof value === 'string') : undefined,
  });
  return rotated
    ? Response.json(rotated)
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleRevokeRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.revokePeerToken(peerId, {
    actor: operatorActor(context, req),
    tokenId: typeof body.tokenId === 'string' ? body.tokenId : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  });
  return peer
    ? Response.json({ peer })
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleDisconnectRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peer = await context.distributedRuntime.disconnectPeer(peerId, {
    actor: operatorActor(context, req),
    note: typeof body.note === 'string' ? body.note : undefined,
    requeueClaimedWork: typeof body.requeueClaimedWork === 'boolean' ? body.requeueClaimedWork : undefined,
  });
  return peer
    ? Response.json({ peer })
    : Response.json({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleInvokeRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) {
    return Response.json({ error: 'Missing remote invoke command' }, { status: 400 });
  }
  const payload = validateRemoteJsonPayload(body.payload, MAX_REMOTE_PAYLOAD_BYTES, 'payload');
  if (payload instanceof Response) return payload;
  try {
    const invoked = await context.distributedRuntime.invokePeer({
      peerId,
      command,
      payload,
      priority: body.priority === 'high' || body.priority === 'default' ? body.priority : 'normal',
      actor: operatorActor(context, req),
      waitMs: boundedPositiveNumber(body.waitMs, 0, 300_000),
      timeoutMs: boundedPositiveNumber(body.timeoutMs, 1_000, 300_000),
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      automationRunId: typeof body.automationRunId === 'string' ? body.automationRunId : undefined,
      automationJobId: typeof body.automationJobId === 'string' ? body.automationJobId : undefined,
      approvalId: typeof body.approvalId === 'string' ? body.approvalId : undefined,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    });
    return Response.json(invoked, { status: 202 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 404 });
  }
}

async function handleCancelRemoteWork(context: DaemonRemoteRouteContext, workId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const work = await context.distributedRuntime.cancelWork(workId, {
    actor: operatorActor(context, req),
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
  return work
    ? Response.json({ work })
    : Response.json({ error: 'Unknown remote work item' }, { status: 404 });
}
