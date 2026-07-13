import type { DaemonSystemRouteHandlers } from './context.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readOptionalStringField,
  type JsonRecord,
} from './route-helpers.js';
import { jsonErrorResponse } from './error-response.js';
import { withAdmin } from './auth-helpers.js';
import type {
  ApprovalRememberTier,
  AutomationDeliveryGuarantee,
  AutomationRouteBindingKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
  DaemonSystemRouteContext,
  WatcherKind,
} from './system-route-types.js';
import { APPROVAL_REMEMBER_TIERS } from './system-route-types.js';

const WATCHER_KIND_VALUES: readonly WatcherKind[] = ['filesystem', 'webhook', 'socket', 'integration', 'polling'];
const WATCHER_SOURCE_KIND_MAP: Readonly<Record<string, WatcherKind>> = {
  webhook: 'webhook',
  file: 'filesystem',
  stream: 'socket',
  api: 'integration',
};
const WATCHER_SOURCE_RECORD_KIND_MAP: Readonly<Record<string, 'webhook' | 'hook' | 'watcher'>> = {
  webhook: 'webhook',
  file: 'hook',
  stream: 'hook',
  api: 'hook',
};
const DEFAULT_WATCHER_INTERVAL_MS = 60_000;
const MIN_WATCHER_INTERVAL_MS = 1_000;
const MAX_WATCHER_INTERVAL_MS = 86_400_000;

interface RouteBindingCreateBody {
  readonly surfaceKind: AutomationSurfaceKind;
  readonly kind: AutomationRouteBindingKind;
  readonly surfaceId: string;
  readonly externalId: string;
}

const systemBodySchemas = createRouteBodySchemaRegistry({
  routeBindingCreate: createRouteBodySchema<RouteBindingCreateBody>('POST /api/system/route-bindings', (body) => {
    const surfaceKind = readOptionalStringField(body, 'surfaceKind');
    const kind = readOptionalStringField(body, 'kind');
    const surfaceId = readOptionalStringField(body, 'surfaceId');
    const externalId = readOptionalStringField(body, 'externalId');
    if (!surfaceKind || !kind || !surfaceId || !externalId) {
      return jsonErrorResponse({ error: 'Missing required route binding fields' }, { status: 400 });
    }
    return {
      surfaceKind: surfaceKind as AutomationSurfaceKind,
      kind: kind as AutomationRouteBindingKind,
      surfaceId,
      externalId,
    };
  }),
});

export function createDaemonSystemRouteHandlers(
  context: DaemonSystemRouteContext,
): DaemonSystemRouteHandlers {
  return {
    getWatchers: () => Response.json({ watchers: context.watcherRegistry.list() }),
    postWatcher: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleRegisterWatcher(context, req);
    },
    patchWatcher: (watcherId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleUpdateWatcher(context, watcherId, req);
    },
    watcherAction: (watcherId, action, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return handleWatcherAction(context, watcherId, action, req);
    },
    deleteWatcher: (watcherId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const removed = context.watcherRegistry.removeWatcher(watcherId);
      return removed
        ? Response.json({ removed: true, id: watcherId })
        : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
    },
    getServiceStatus: () => Response.json({
      ...context.platformServiceManager.status(),
      network: {
        controlPlane: context.inspectInboundTls('controlPlane'),
        httpListener: context.inspectInboundTls('httpListener'),
        outbound: context.inspectOutboundTls(),
      },
    }),
    installService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.install());
    },
    startService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.start());
    },
    stopService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.stop());
    },
    restartService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.restart());
    },
    uninstallService: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.platformServiceManager.uninstall());
    },
    getRouteBindings: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ bindings: context.routeBindings.listBindings() });
    },
    postRouteBinding: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const input = systemBodySchemas.routeBindingCreate.parse(body);
      if (input instanceof Response) return input;
      const binding = await context.routeBindings.upsertBinding({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: input.kind,
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
        externalId: input.externalId,
        sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined,
        threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined,
        deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined,
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
        runId: typeof body.runId === 'string' ? body.runId : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      });
      return Response.json(binding, { status: 201 });
    },
    patchRouteBinding: async (bindingId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const updated = await context.routeBindings.patchBinding(bindingId, {
        ...(body.sessionPolicy !== undefined ? { sessionPolicy: typeof body.sessionPolicy === 'string' ? body.sessionPolicy as AutomationSessionPolicy : undefined } : {}),
        ...(body.threadPolicy !== undefined ? { threadPolicy: typeof body.threadPolicy === 'string' ? body.threadPolicy as AutomationThreadPolicy : undefined } : {}),
        ...(body.deliveryGuarantee !== undefined ? { deliveryGuarantee: typeof body.deliveryGuarantee === 'string' ? body.deliveryGuarantee as AutomationDeliveryGuarantee : undefined } : {}),
        ...(body.threadId !== undefined ? { threadId: typeof body.threadId === 'string' ? body.threadId : undefined } : {}),
        ...(body.channelId !== undefined ? { channelId: typeof body.channelId === 'string' ? body.channelId : undefined } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId === null ? null : typeof body.sessionId === 'string' ? body.sessionId : undefined } : {}),
        ...(body.jobId !== undefined ? { jobId: body.jobId === null ? null : typeof body.jobId === 'string' ? body.jobId : undefined } : {}),
        ...(body.runId !== undefined ? { runId: body.runId === null ? null : typeof body.runId === 'string' ? body.runId : undefined } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      });
      return updated
        ? Response.json(updated)
        : jsonErrorResponse({ error: 'Unknown route binding' }, { status: 404 });
    },
    deleteRouteBinding: async (bindingId, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const removed = await context.routeBindings.removeBinding(bindingId);
      return removed
        ? Response.json({ removed: true, id: bindingId })
        : jsonErrorResponse({ error: 'Unknown route binding' }, { status: 404 });
    },
    getApprovals: () => {
      if (!context.integrationHelpers) {
        return jsonErrorResponse({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      return Response.json(context.integrationHelpers.getApprovalSnapshot());
    },
    approvalAction: (approvalId, action, req) => handleApprovalAction(context, approvalId, action, req),
    getConfig: (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json(context.configManager.getAll());
    },
    getCredentials: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      if (!context.credentialStatus) {
        // Honest degraded state: no shared secret store is wired, so we cannot
        // truthfully report credential status. Never fabricate an empty "no
        // credentials" answer that a caller would read as "nothing configured".
        return jsonErrorResponse(
          { error: 'Shared credential store unavailable', code: 'CREDENTIAL_STORE_UNAVAILABLE' },
          { status: 503 },
        );
      }
      const key = new URL(req.url).searchParams.get('key');
      if (key !== null) {
        const trimmed = key.trim();
        if (!trimmed) {
          return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
        }
        const record = await context.credentialStatus.get(trimmed);
        return Response.json({ available: true, credentials: record ? [record] : [] });
      }
      const credentials = await context.credentialStatus.list();
      return Response.json({ available: true, credentials });
    },
    postConfig: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const payload = await context.parseJsonBody(req);
      if (payload instanceof Response) return payload;
      const { key, value } = payload;
      if (!key || typeof key !== 'string') {
        return jsonErrorResponse({ error: 'Missing or invalid key' }, { status: 400 });
      }
      if (key === 'runtime.workingDir') {
        return handleWorkingDirectoryConfig(context, key, value);
      }
      if (!context.isValidConfigKey(key)) {
        return jsonErrorResponse({ error: 'Invalid config key' }, { status: 400 });
      }
      try {
        context.configManager.setDynamic(key, value);
      } catch (error: unknown) {
        return jsonErrorResponse(error, { status: 400, fallbackMessage: 'Failed to set config' });
      }
      return Response.json({ success: true, key, value });
    },
  };
}

async function handleRegisterWatcher(context: DaemonSystemRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : '';
  const id = typeof body.id === 'string' && body.id.trim().length > 0
    ? body.id.trim()
    : label
      ? ((): string => {
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          // If the label consists entirely of special chars the slug will be empty.
          return slug ? `watcher-${slug}` : `watcher-${Date.now()}`;
        })()
      : `watcher-${Date.now()}`;
  const kind = readWatcherKind(body.kind, body.sourceKind, 'polling');
  const intervalMs = readWatcherIntervalMs(body.intervalMs, context.configManager.get('watchers.pollIntervalMs'));
  if (!label) {
    return jsonErrorResponse({ error: 'Missing watcher label' }, { status: 400 });
  }
  const metadata = typeof body.metadata === 'object' && body.metadata !== null
    ? body.metadata as Record<string, unknown>
    : {};
  const sourceMetadata = {
    ...metadata,
    ...(typeof body.url === 'string' ? { url: body.url } : {}),
    ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
    ...(typeof body.path === 'string' ? { path: body.path } : {}),
    ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
    ...(typeof body.address === 'string' ? { address: body.address } : {}),
    ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
  };
  const record = context.watcherRegistry.registerWatcher({
    id,
    label,
    kind,
    source: {
      id: typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : `source:${id}`,
      kind: typeof body.sourceKind === 'string'
        ? WATCHER_SOURCE_RECORD_KIND_MAP[body.sourceKind] ?? 'watcher'
        : 'watcher',
      label,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: sourceMetadata,
    },
    intervalMs,
    metadata: sourceMetadata,
    ...(typeof body.run === 'string' ? { run: () => body.run as string } : {}),
  });
  return Response.json(record, { status: 201 });
}

async function handleWorkingDirectoryConfig(
  context: DaemonSystemRouteContext,
  key: string,
  value: unknown,
): Promise<Response> {
  if (!context.swapManager) {
    return jsonErrorResponse({ error: 'Workspace swapping is not available in this daemon configuration.' }, { status: 400 });
  }
  if (typeof value !== 'string' || !value.trim()) {
    return jsonErrorResponse({ error: 'runtime.workingDir value must be a non-empty string path.', code: 'INVALID_PATH' }, { status: 400 });
  }
  const result = await context.swapManager.requestSwap(value);
  if (result.ok) {
    return Response.json({ success: true, key, value: result.current, previous: result.previous });
  }
  return jsonErrorResponse(
    {
      error: result.reason,
      code: result.code,
      ...(result.code === 'WORKSPACE_BUSY' ? { retryAfter: result.retryAfter } : {}),
    },
    { status: result.code === 'WORKSPACE_BUSY' ? 409 : 400 },
  );
}

function readWatcherKind(kind: unknown, sourceKind: unknown, fallback: WatcherKind): WatcherKind {
  if (typeof kind === 'string' && (WATCHER_KIND_VALUES as readonly string[]).includes(kind)) {
    return kind as WatcherKind;
  }
  return typeof sourceKind === 'string'
    ? WATCHER_SOURCE_KIND_MAP[sourceKind] ?? fallback
    : fallback;
}

function readWatcherIntervalMs(value: unknown, fallbackValue: unknown): number {
  const fallback = typeof fallbackValue === 'number' && Number.isFinite(fallbackValue)
    ? fallbackValue
    : DEFAULT_WATCHER_INTERVAL_MS;
  return readBoundedBodyInteger(value, fallback, MAX_WATCHER_INTERVAL_MS, MIN_WATCHER_INTERVAL_MS);
}

async function handleUpdateWatcher(context: DaemonSystemRouteContext, watcherId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const current = context.watcherRegistry.getWatcher(watcherId);
  if (!current) {
    return jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  const nextSourceKind = typeof body.sourceKind === 'string'
    ? WATCHER_SOURCE_RECORD_KIND_MAP[body.sourceKind] ?? 'watcher'
    : current.source.kind;
  const updated = context.watcherRegistry.registerWatcher({
    id: watcherId,
    label: typeof body.label === 'string' ? body.label : current.label,
    kind: readWatcherKind(body.kind, undefined, current.kind),
    source: {
      ...current.source,
      ...(typeof body.source === 'object' && body.source !== null ? body.source as Partial<typeof current.source> : {}),
      kind: nextSourceKind,
      ...(typeof body.sourceId === 'string' && body.sourceId.trim().length > 0 ? { id: body.sourceId.trim() } : {}),
      ...(typeof body.label === 'string' && body.label.trim().length > 0 ? { label: body.label.trim() } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      metadata: {
        ...current.source.metadata,
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
        ...(typeof body.path === 'string' ? { path: body.path } : {}),
        ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
        ...(typeof body.address === 'string' ? { address: body.address } : {}),
        ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {}),
      },
      updatedAt: Date.now(),
    },
    intervalMs: body.intervalMs !== undefined ? readWatcherIntervalMs(body.intervalMs, current.intervalMs) : (current.intervalMs ?? DEFAULT_WATCHER_INTERVAL_MS),
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : current.metadata,
  });
  return Response.json(updated);
}

async function handleWatcherAction(
  context: DaemonSystemRouteContext,
  watcherId: string,
  action: 'start' | 'stop' | 'run',
  _req: Request,
): Promise<Response> {
  if (action === 'start') {
    const watcher = context.watcherRegistry.startWatcher(watcherId);
    return watcher
      ? Response.json(watcher)
      : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  if (action === 'stop') {
    const watcher = context.watcherRegistry.stopWatcher(watcherId, 'operator-stop');
    return watcher
      ? Response.json(watcher)
      : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
  }
  const watcher = await context.watcherRegistry.runWatcherNow(watcherId);
  return watcher
    ? Response.json(watcher)
    : jsonErrorResponse({ error: 'Unknown watcher' }, { status: 404 });
}

async function handleApprovalAction(
  context: DaemonSystemRouteContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  const payload = body instanceof Response || body === null ? {} as JsonRecord : body;
  const actor = context.requireAuthenticatedSession(req)?.username ?? 'operator';
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  if (action === 'claim') {
    const approval = await context.approvalBroker.claimApproval(approvalId, actor, 'web', note);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
  }
  if (action === 'cancel') {
    const approval = await context.approvalBroker.cancelApproval(approvalId, actor, 'web', note);
    return approval
      ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
  }
  const selectedHunks = action === 'approve' ? readSelectedHunks(payload.selectedHunks) : undefined;
  if (selectedHunks instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, selectedHunks);
  }
  // The full decision reach travels over HTTP, not just note/remember: a tier
  // grant, a deny reason, and an argument-modifying approval (e.g. the typed
  // answer to a command's terminal prompt) must all reach the same broker
  // resolution the in-process path uses. Malformed values are honest 400s —
  // silently dropping them is exactly the defect this closes.
  const rememberTier = readRememberTier(payload.rememberTier);
  if (rememberTier instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, rememberTier);
  }
  if (payload.reason !== undefined && typeof payload.reason !== 'string') {
    return context.recordApiResponse(
      req,
      `/api/approvals/${approvalId}/${action}`,
      jsonErrorResponse({ error: 'reason must be a string.' }, { status: 400 }),
    );
  }
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const modifiedArgs = action === 'approve' ? readModifiedArgs(payload.modifiedArgs) : undefined;
  if (modifiedArgs instanceof Response) {
    return context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, modifiedArgs);
  }
  let approval: unknown | null;
  try {
    approval = await context.approvalBroker.resolveApproval(approvalId, {
      approved: action === 'approve',
      remember: typeof payload.remember === 'boolean' ? payload.remember : false,
      actor,
      actorSurface: 'web',
      note,
      ...(selectedHunks !== undefined ? { selectedHunks } : {}),
      ...(rememberTier !== undefined ? { rememberTier } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(modifiedArgs !== undefined ? { modifiedArgs } : {}),
    });
  } catch (error) {
    // The broker throws a 400-tagged error for an out-of-range or non-edit
    // per-hunk selection. Surface it as an honest HTTP 400, not a 500.
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : 'Approval resolution failed.';
    return context.recordApiResponse(
      req,
      `/api/approvals/${approvalId}/${action}`,
      jsonErrorResponse({ error: message }, { status }),
    );
  }
  return approval
    ? context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval, recorded: recordedDecision(approval) }))
    : context.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, jsonErrorResponse({ error: 'Unknown approval' }, { status: 404 }));
}

/**
 * Read an optional rememberTier off the request payload. Undefined when
 * absent; a 400 Response when present but not one of the broker's tiers.
 */
function readRememberTier(value: unknown): ApprovalRememberTier | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !(APPROVAL_REMEMBER_TIERS as readonly string[]).includes(value)) {
    return jsonErrorResponse(
      { error: `rememberTier must be one of: ${APPROVAL_REMEMBER_TIERS.join(', ')}.` },
      { status: 400 },
    );
  }
  return value as ApprovalRememberTier;
}

/**
 * Read an optional modifiedArgs record off the request payload. Undefined
 * when absent; a 400 Response when present but not a plain object.
 */
function readModifiedArgs(value: unknown): Record<string, unknown> | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return jsonErrorResponse({ error: 'modifiedArgs must be an object of tool arguments.' }, { status: 400 });
  }
  return value as Record<string, unknown>;
}

/**
 * What the broker actually recorded, derived from the RETURNED record —
 * never echoed from the request. An already-resolved approval keeps its
 * original decision, so this stays honest when a late approve/deny no-ops.
 */
function recordedDecision(approval: unknown): {
  approved: boolean;
  rememberTier: ApprovalRememberTier | null;
  reasonStored: boolean;
  modifiedArgsDelivered: boolean;
} {
  const decision = (approval as { decision?: {
    approved?: unknown;
    rememberTier?: unknown;
    reason?: unknown;
    modifiedArgs?: unknown;
  } | undefined }).decision;
  return {
    approved: decision?.approved === true,
    rememberTier: typeof decision?.rememberTier === 'string' && (APPROVAL_REMEMBER_TIERS as readonly string[]).includes(decision.rememberTier)
      ? decision.rememberTier as ApprovalRememberTier
      : null,
    reasonStored: typeof decision?.reason === 'string',
    modifiedArgsDelivered: decision?.modifiedArgs !== undefined,
  };
}

/**
 * Read an optional selectedHunks array off the request payload. Returns the
 * validated number[] when present and well-formed, undefined when absent, or a
 * 400 Response when present but malformed (non-array, or an entry that is not a
 * finite integer). Range validation against the specific approval's hunk count
 * is the broker's job (it owns the pending edit list).
 */
function readSelectedHunks(value: unknown): readonly number[] | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) {
    return jsonErrorResponse({ error: 'selectedHunks must be an array of integer hunk indices.' }, { status: 400 });
  }
  return value as readonly number[];
}
