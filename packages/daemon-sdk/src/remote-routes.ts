import type { DaemonRemoteManagementRouteHandlers } from './context.js';
import { jsonErrorResponse } from './error-response.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readOptionalStringField,
  readStringArrayField,
  serializableJsonResponse,
  type JsonRecord,
} from './route-helpers.js';

type RemotePeerAuth = unknown;
const MAX_REMOTE_RESULT_BYTES = 1_000_000;
const MAX_REMOTE_PAYLOAD_BYTES = 1_000_000;
const MAX_REMOTE_CAPABILITIES = 128;
const MAX_REMOTE_COMMANDS = 128;
const MAX_REMOTE_SCOPES = 128;

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

type RemoteMetadata = Record<string, unknown>;

type RemotePairRequestBody = {
  readonly peerKind: 'device' | 'node';
  readonly requestedId?: string;
  readonly label: string;
  readonly platform?: string;
  readonly deviceFamily?: string;
  readonly version?: string;
  readonly clientMode?: string;
  readonly capabilities: readonly string[];
  readonly commands: readonly string[];
  readonly metadata: RemoteMetadata;
  readonly ttlMs?: number;
};

type RemotePairVerifyBody = {
  readonly requestId: string;
  readonly challenge: string;
  readonly metadata: RemoteMetadata;
};

type RemotePeerHeartbeatBody = {
  readonly capabilities?: readonly string[];
  readonly commands?: readonly string[];
  readonly version?: string;
  readonly clientMode?: string;
  readonly metadata: RemoteMetadata;
};

type RemoteWorkPullBody = {
  readonly maxItems?: number;
  readonly leaseMs?: number;
};

type RemoteWorkCompleteBody = {
  readonly status?: 'completed' | 'failed' | 'cancelled';
  readonly result: unknown;
  readonly error?: string;
  readonly metadata: RemoteMetadata;
};

type RemoteOperatorNoteBody = {
  readonly note?: string;
  readonly reason?: string;
  readonly label?: string;
  readonly tokenId?: string;
  readonly requeueClaimedWork?: boolean;
  readonly scopes?: readonly string[];
};

type RemoteInvokeBody = {
  readonly command: string;
  readonly payload: unknown;
  readonly priority: 'high' | 'default' | 'normal';
  readonly waitMs?: number;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly automationRunId?: string;
  readonly automationJobId?: string;
  readonly approvalId?: string;
  readonly metadata: RemoteMetadata;
};

interface DaemonRemoteRouteContext {
  readonly authToken?: string | null;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<RemotePeerAuth | Response>;
  readonly requireAuthenticatedSession: (req: Request) => SessionUserLike | null;
  readonly distributedRuntime: DistributedRuntimeRouteService;
}

const remoteBodySchemas = createRouteBodySchemaRegistry({
  pairRequest: createRouteBodySchema<RemotePairRequestBody>('POST /api/remote/pair', (body) => {
    const label = readOptionalStringField(body, 'label');
    if (!label) return jsonErrorResponse({ error: 'Missing remote peer label' }, { status: 400 });
    const requestedId = readOptionalStringField(body, 'requestedId');
    const platform = readOptionalStringField(body, 'platform');
    const deviceFamily = readOptionalStringField(body, 'deviceFamily');
    const version = readOptionalStringField(body, 'version');
    const clientMode = readOptionalStringField(body, 'clientMode');
    const ttlMs = boundedPositiveNumber(body.ttlMs, 1_000, 86_400_000);
    return {
      peerKind: body.peerKind === 'device' ? 'device' : 'node',
      ...(requestedId ? { requestedId } : {}),
      label,
      ...(platform ? { platform } : {}),
      ...(deviceFamily ? { deviceFamily } : {}),
      ...(version ? { version } : {}),
      ...(clientMode ? { clientMode } : {}),
      capabilities: readStringArrayField(body, 'capabilities', MAX_REMOTE_CAPABILITIES) ?? [],
      commands: readStringArrayField(body, 'commands', MAX_REMOTE_COMMANDS) ?? [],
      metadata: readRemoteMetadata(body.metadata),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    };
  }),
  pairVerify: createRouteBodySchema<RemotePairVerifyBody>('POST /api/remote/pair/verify', (body) => {
    const requestId = readOptionalStringField(body, 'requestId');
    const challenge = readOptionalStringField(body, 'challenge');
    if (!requestId || !challenge) {
      return jsonErrorResponse({ error: 'Missing requestId or challenge' }, { status: 400 });
    }
    return { requestId, challenge, metadata: readRemoteMetadata(body.metadata) };
  }),
  peerHeartbeat: createRouteBodySchema<RemotePeerHeartbeatBody>('POST /api/remote/peers/heartbeat', (body) => {
    const capabilities = readStringArrayField(body, 'capabilities', MAX_REMOTE_CAPABILITIES);
    const commands = readStringArrayField(body, 'commands', MAX_REMOTE_COMMANDS);
    const version = readOptionalStringField(body, 'version');
    const clientMode = readOptionalStringField(body, 'clientMode');
    return {
      ...(capabilities ? { capabilities } : {}),
      ...(commands ? { commands } : {}),
      ...(version ? { version } : {}),
      ...(clientMode ? { clientMode } : {}),
      metadata: readRemoteMetadata(body.metadata),
    };
  }),
  workPull: createRouteBodySchema<RemoteWorkPullBody>('POST /api/remote/work/pull', (body) => {
    const maxItems = boundedPositiveNumber(body.maxItems, 1, 100);
    const leaseMs = boundedPositiveNumber(body.leaseMs, 1_000, 3_600_000);
    return {
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(leaseMs !== undefined ? { leaseMs } : {}),
    };
  }),
  workComplete: createRouteBodySchema<RemoteWorkCompleteBody>('POST /api/remote/work/:workId/complete', (body) => {
    const error = readOptionalStringField(body, 'error');
    return {
      ...(body.status === 'failed' || body.status === 'cancelled' || body.status === 'completed' ? { status: body.status } : {}),
      result: body.result,
      ...(error ? { error } : {}),
      metadata: readRemoteMetadata(body.metadata),
    };
  }),
  operatorNote: createRouteBodySchema<RemoteOperatorNoteBody>('POST /api/remote/operator-action', (body) => {
    const note = readOptionalStringField(body, 'note');
    const reason = readOptionalStringField(body, 'reason');
    const label = readOptionalStringField(body, 'label');
    const tokenId = readOptionalStringField(body, 'tokenId');
    const scopes = readStringArrayField(body, 'scopes', MAX_REMOTE_SCOPES);
    return {
      ...(note ? { note } : {}),
      ...(reason ? { reason } : {}),
      ...(label ? { label } : {}),
      ...(tokenId ? { tokenId } : {}),
      ...(typeof body.requeueClaimedWork === 'boolean' ? { requeueClaimedWork: body.requeueClaimedWork } : {}),
      ...(scopes ? { scopes } : {}),
    };
  }),
  invoke: createRouteBodySchema<RemoteInvokeBody>('POST /api/remote/peers/:peerId/invoke', (body) => {
    const command = readOptionalStringField(body, 'command');
    if (!command) return jsonErrorResponse({ error: 'Missing remote invoke command' }, { status: 400 });
    const waitMs = boundedPositiveNumber(body.waitMs, 0, 300_000);
    const timeoutMs = boundedPositiveNumber(body.timeoutMs, 1_000, 300_000);
    const sessionId = readOptionalStringField(body, 'sessionId');
    const routeId = readOptionalStringField(body, 'routeId');
    const automationRunId = readOptionalStringField(body, 'automationRunId');
    const automationJobId = readOptionalStringField(body, 'automationJobId');
    const approvalId = readOptionalStringField(body, 'approvalId');
    return {
      command,
      payload: body.payload,
      priority: body.priority === 'high' || body.priority === 'default' ? body.priority : 'normal',
      ...(waitMs !== undefined ? { waitMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(routeId ? { routeId } : {}),
      ...(automationRunId ? { automationRunId } : {}),
      ...(automationJobId ? { automationJobId } : {}),
      ...(approvalId ? { approvalId } : {}),
      metadata: readRemoteMetadata(body.metadata),
    };
  }),
});

export function createDaemonRemoteRouteHandlers(
  context: DaemonRemoteRouteContext,
): DaemonRemoteManagementRouteHandlers {
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
  const input = remoteBodySchemas.pairRequest.parse(body);
  if (input instanceof Response) return input;
  const created = await context.distributedRuntime.requestPairing({
    ...input,
    metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
    requestedBy: 'remote',
  });
  return Response.json(created, { status: 201 });
}

export async function handleRemotePairVerify(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.pairVerify.parse(body);
  if (input instanceof Response) return input;
  const verified = await context.distributedRuntime.verifyPairRequest(input.requestId, input.challenge, {
    metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
  });
  return verified
    ? Response.json(verified)
    : jsonErrorResponse({ error: 'Pair request not approved, expired, or invalid' }, { status: 404 });
}

export async function handleRemotePeerHeartbeat(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, 'remote:heartbeat');
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.peerHeartbeat.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.heartbeatPeer(auth, {
    ...input,
    metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
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
  const input = remoteBodySchemas.workPull.parse(body);
  if (input instanceof Response) return input;
  const work = await context.distributedRuntime.claimWork(auth, {
    maxItems: input.maxItems,
    leaseMs: input.leaseMs,
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
  const input = remoteBodySchemas.workComplete.parse(body);
  if (input instanceof Response) return input;
  const result = validateRemoteJsonPayload(input.result, MAX_REMOTE_RESULT_BYTES, 'result');
  if (result instanceof Response) return result;
  const work = await context.distributedRuntime.completeWork(auth, workId, {
    status: input.status,
    result,
    error: input.error,
    metadata: input.metadata,
  });
  return work
    ? Response.json({ work })
    : jsonErrorResponse({ error: 'Unknown or unclaimed remote work item' }, { status: 404 });
}

function boundedPositiveNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateRemoteJsonPayload(value: unknown, maxBytes: number, field: string): unknown | Response {
  const size = estimateJsonByteLengthWithinLimit(value ?? null, maxBytes);
  if (size.kind === 'invalid') {
    return jsonErrorResponse({
      error: `Remote ${field} must be JSON-serializable`,
      code: 'INVALID_REMOTE_JSON_PAYLOAD',
    }, { status: 400 });
  }
  if (size.byteLength <= maxBytes) return value;
  return jsonErrorResponse({
    error: `Remote ${field} exceeds ${maxBytes} bytes after JSON encoding. Reduce payload size before retrying.`,
    code: 'REMOTE_PAYLOAD_TOO_LARGE',
  }, { status: 413 });
}

function estimateJsonByteLengthWithinLimit(
  value: unknown,
  maxBytes: number,
): { readonly kind: 'ok'; readonly byteLength: number } | { readonly kind: 'invalid' } {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return { kind: 'ok', byteLength: 4 };
    const byteLength = Buffer.byteLength(encoded, 'utf8');
    return { kind: 'ok', byteLength: Math.min(byteLength, maxBytes + 1) };
  } catch (error) {
    void error;
    return { kind: 'invalid' };
  }
}

type ClientHintForwardedFor = string & { readonly __goodvibesClientHintForwardedFor: unique symbol };

function readRemoteMetadata(value: unknown): RemoteMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RemoteMetadata
    : {};
}

function readMetadataWithClientHintForwardedFor(req: Request, value: unknown): Record<string, unknown> {
  const metadata = { ...readRemoteMetadata(value) };
  const clientHintForwardedFor = readClientHintForwardedFor(req);
  return clientHintForwardedFor ? { ...metadata, x_forwarded_for_untrusted: clientHintForwardedFor } : metadata;
}

function readClientHintForwardedFor(req: Request): ClientHintForwardedFor | undefined {
  // x-forwarded-for is caller-controlled unless the daemon is explicitly behind
  // a trusted proxy. Preserve a small display/audit hint under an explicit
  // client-hint key, but never use it for authorization decisions.
  const value = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return value ? value as ClientHintForwardedFor : undefined;
}

function operatorActor(context: DaemonRemoteRouteContext, req: Request): string {
  return context.authToken ? 'shared-token' : context.requireAuthenticatedSession(req)?.username ?? 'operator';
}

async function handleApproveRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const approved = await context.distributedRuntime.approvePairRequest(requestId, {
    actor: operatorActor(context, req),
    note: input.note,
    label: input.label,
    metadata: readRemoteMetadata(body.metadata),
  });
  return approved
    ? Response.json(approved)
    : jsonErrorResponse({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRejectRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const rejected = await context.distributedRuntime.rejectPairRequest(requestId, {
    actor: operatorActor(context, req),
    note: input.note,
  });
  return rejected
    ? Response.json(rejected)
    : jsonErrorResponse({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRotateRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const rotated = await context.distributedRuntime.rotatePeerToken(peerId, {
    actor: operatorActor(context, req),
    label: input.label,
    scopes: input.scopes,
  });
  return rotated
    ? Response.json(rotated)
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleRevokeRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.revokePeerToken(peerId, {
    actor: operatorActor(context, req),
    tokenId: input.tokenId,
    note: input.note,
  });
  return peer
    ? Response.json({ peer })
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleDisconnectRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.disconnectPeer(peerId, {
    actor: operatorActor(context, req),
    note: input.note,
    requeueClaimedWork: input.requeueClaimedWork,
  });
  return peer
    ? Response.json({ peer })
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleInvokeRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.invoke.parse(body);
  if (input instanceof Response) return input;
  const payload = validateRemoteJsonPayload(input.payload, MAX_REMOTE_PAYLOAD_BYTES, 'payload');
  if (payload instanceof Response) return payload;
  try {
    const invoked = await context.distributedRuntime.invokePeer({
      peerId,
      command: input.command,
      payload,
      priority: input.priority,
      actor: operatorActor(context, req),
      waitMs: input.waitMs,
      timeoutMs: input.timeoutMs,
      sessionId: input.sessionId,
      routeId: input.routeId,
      automationRunId: input.automationRunId,
      automationJobId: input.automationJobId,
      approvalId: input.approvalId,
      metadata: input.metadata,
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
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const work = await context.distributedRuntime.cancelWork(workId, {
    actor: operatorActor(context, req),
    reason: input.reason,
  });
  return work
    ? Response.json({ work })
    : jsonErrorResponse({ error: 'Unknown remote work item' }, { status: 404 });
}
