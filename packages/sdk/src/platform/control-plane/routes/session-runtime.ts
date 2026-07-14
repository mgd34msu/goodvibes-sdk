/**
 * routes/session-runtime.ts
 *
 * Per-session permission mode (get/set) and context-usage exposure on the
 * operator wire — the session-scoped RPCs that were missing, so a remote
 * surface (webui) can read/write a session's permission mode and read its
 * context-window pressure instead of only touching the daemon-wide
 * `permissions.mode` config the way the in-process TUI reads per-session
 * state.
 *
 * SCOPE OF TRUTH: the daemon can only get/set the permission mode of, and read
 * the context usage of, the LIVE LOCAL runtime it actually hosts. A request
 * for any other session id is an honest 404 (SESSION_NOT_LOCAL) rather than a
 * fabricated answer — mirroring the honest-refusal pattern the fleet archive
 * verbs use (routes/fleet.ts).
 *
 * MODE-CHANGE EVENT: `sessions.permissionMode.set` mutates `permissions.mode`
 * through the ordinary config surface, which the already-wired
 * `bindPermissionModeChangeEvent` binding (permissions/mode-change-emitter.ts,
 * attached in runtime/services.ts) turns into a runtime.permissions
 * PERMISSION_MODE_CHANGED event — so surfaces stay in sync without this verb
 * emitting its own event.
 *
 * HONESTY (context usage): the token figure is the estimator's
 * (estimatedContextTokens), NOT a measured provider prompt-token count; the
 * field name and the `estimated: true` flag keep that explicit. The percentage
 * and remaining tokens derive from that estimate via the one shared
 * runtime/context-usage.ts helper the in-process read model also uses.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { PermissionMode } from '../../config/schema-types.js';
import { deriveContextUsage } from '../../runtime/context-usage.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/**
 * The operator-facing permission-mode vocabulary. `custom` is read-only
 * (surfaced by get when a session is in a custom rule set) and is never a
 * settable value.
 */
export type OperatorPermissionMode = 'plan' | 'normal' | 'accept-edits' | 'auto' | 'custom';
export type SettableOperatorPermissionMode = Exclude<OperatorPermissionMode, 'custom'>;

/** Map the internal config permission mode onto the operator vocabulary. */
export function toOperatorPermissionMode(mode: PermissionMode): OperatorPermissionMode {
  switch (mode) {
    case 'prompt':
      return 'normal';
    case 'allow-all':
      return 'auto';
    case 'plan':
      return 'plan';
    case 'accept-edits':
      return 'accept-edits';
    case 'custom':
      return 'custom';
  }
}

/** Map a settable operator mode back onto the internal config permission mode. */
export function toConfigPermissionMode(mode: string): PermissionMode {
  switch (mode) {
    case 'normal':
      return 'prompt';
    case 'auto':
      return 'allow-all';
    case 'plan':
      return 'plan';
    case 'accept-edits':
      return 'accept-edits';
    default:
      throw new GatewayVerbError(
        `Invalid permission mode: ${String(mode)} (expected one of plan, normal, accept-edits, auto)`,
        'INVALID_ARGUMENT',
        400,
      );
  }
}

/** The measured/estimated context usage of a single session's live runtime. */
export interface SessionContextUsage {
  readonly estimatedContextTokens: number;
  readonly contextWindow: number;
  readonly contextUsagePct: number;
  readonly contextRemainingTokens: number;
}

/**
 * The live-turn control surface an interactive runtime host (an Orchestrator)
 * binds so remote surfaces can cancel one in-flight tool call and manage the
 * pending mid-turn message queue. Matches the Orchestrator's own public
 * methods structurally, so binding is `holder.bind(orchestrator)`.
 */
export interface SessionLiveTurnControls {
  cancelToolCall(callId: string): boolean;
  listQueuedMessages(): ReadonlyArray<{ readonly id: string; readonly queuedAt: number; readonly text: string }>;
  editQueuedMessage(id: string, text: string): boolean;
  deleteQueuedMessage(id: string): boolean;
}

/**
 * Settable holder an interactive consumer binds its live Orchestrator-backed
 * controls into (the contextAccountingHolder pattern): the verbs read whatever
 * is currently bound; unbinding (or a different instance being bound) is safe.
 */
export class SessionLiveTurnControlsHolder {
  private controls: SessionLiveTurnControls | null = null;
  bind(controls: SessionLiveTurnControls): void {
    this.controls = controls;
  }
  /** Unbind only when the caller is still the bound instance (idempotent). */
  unbind(controls: SessionLiveTurnControls): void {
    if (this.controls === controls) this.controls = null;
  }
  get(): SessionLiveTurnControls | null {
    return this.controls;
  }
}

/**
 * The narrow control surface the session-runtime verbs need over the live
 * local runtime. `isLocalSession` decides whether a requested session id is
 * the runtime this daemon hosts (the only one whose mode/usage it can answer
 * for truthfully).
 */
export interface SessionRuntimeControls {
  isLocalSession(sessionId: string): boolean;
  getPermissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  getContextUsage(): SessionContextUsage;
  /** The live-turn controls currently bound, or null when no interactive runtime is attached. */
  getLiveTurnControls(): SessionLiveTurnControls | null;
}

function requireLocalSessionId(controls: SessionRuntimeControls, params: Record<string, unknown>): string {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) {
    throw new GatewayVerbError('sessionId is required', 'INVALID_ARGUMENT', 400);
  }
  if (!controls.isLocalSession(sessionId)) {
    throw new GatewayVerbError(
      `This daemon does not host a live runtime for session ${sessionId}.`,
      'SESSION_NOT_LOCAL',
      404,
    );
  }
  return sessionId;
}

export function createSessionPermissionModeGetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    return { sessionId, mode: toOperatorPermissionMode(controls.getPermissionMode()) };
  };
}

export function createSessionPermissionModeSetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const nextMode = toConfigPermissionMode(typeof params.mode === 'string' ? params.mode : '');
    const previousMode = toOperatorPermissionMode(controls.getPermissionMode());
    controls.setPermissionMode(nextMode);
    return {
      sessionId,
      mode: toOperatorPermissionMode(nextMode),
      previousMode,
    };
  };
}

/** Resolve the bound live-turn controls or refuse honestly (no fabricated success). */
function requireLiveTurnControls(controls: SessionRuntimeControls): SessionLiveTurnControls {
  const live = controls.getLiveTurnControls();
  if (!live) {
    throw new GatewayVerbError(
      'No interactive runtime is bound on this daemon — live-turn controls are unavailable for this session.',
      'LIVE_TURN_CONTROLS_UNAVAILABLE',
      404,
    );
  }
  return live;
}

export function createSessionToolCallCancelHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls);
    const callId = typeof params.callId === 'string' ? params.callId.trim() : '';
    if (!callId) {
      throw new GatewayVerbError('callId is required', 'INVALID_ARGUMENT', 400);
    }
    if (!live.cancelToolCall(callId)) {
      throw new GatewayVerbError(
        `No tool call ${callId} is currently in flight (already settled, or never started).`,
        'TOOL_CALL_NOT_RUNNING',
        404,
      );
    }
    return { sessionId, callId, cancelled: true };
  };
}

export function createSessionQueuedMessagesListHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    const live = requireLiveTurnControls(controls);
    return { sessionId, messages: live.listQueuedMessages() };
  };
}

export function createSessionQueuedMessageEditHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls);
    const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!messageId) {
      throw new GatewayVerbError('messageId is required', 'INVALID_ARGUMENT', 400);
    }
    if (!text.trim()) {
      throw new GatewayVerbError('text must be non-empty', 'INVALID_ARGUMENT', 400);
    }
    if (!live.editQueuedMessage(messageId, text)) {
      throw new GatewayVerbError(
        `Message ${messageId} is not in the pending queue (already delivered — delivered messages are immutable).`,
        'MESSAGE_NOT_QUEUED',
        404,
      );
    }
    return { sessionId, id: messageId, text };
  };
}

export function createSessionQueuedMessageDeleteHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireLocalSessionId(controls, params);
    const live = requireLiveTurnControls(controls);
    const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
    if (!messageId) {
      throw new GatewayVerbError('messageId is required', 'INVALID_ARGUMENT', 400);
    }
    if (!live.deleteQueuedMessage(messageId)) {
      throw new GatewayVerbError(
        `Message ${messageId} is not in the pending queue (already delivered — delivered messages are immutable).`,
        'MESSAGE_NOT_QUEUED',
        404,
      );
    }
    return { sessionId, id: messageId, deleted: true };
  };
}

export function createSessionContextUsageGetHandler(controls: SessionRuntimeControls): GatewayMethodHandler {
  return (invocation) => {
    const sessionId = requireLocalSessionId(controls, readInvocationParams(invocation));
    const usage = controls.getContextUsage();
    return {
      sessionId,
      estimatedContextTokens: usage.estimatedContextTokens,
      contextWindow: usage.contextWindow,
      contextUsagePct: usage.contextUsagePct,
      contextRemainingTokens: usage.contextRemainingTokens,
      // The token figure is the estimator's, never a measured provider count.
      estimated: true,
    };
  };
}

/**
 * The `permissions.mode` config surface the session-runtime controls read and
 * write. The daemon's real ConfigManager (whose generic get/set resolve
 * `permissions.mode` to {@link PermissionMode}) satisfies this narrower shape.
 */
export interface PermissionModeConfig {
  get(key: 'permissions.mode'): PermissionMode;
  set(key: 'permissions.mode', value: PermissionMode): void;
}

/** The slice of the runtime state the session-runtime controls read. */
export interface SessionRuntimeStateReader {
  getState(): {
    readonly session: { readonly id: string };
    readonly conversation: { readonly estimatedContextTokens: number };
    readonly model: { readonly tokenLimits: { readonly contextWindow: number } };
  };
}

/**
 * Build the concrete controls over the daemon's config + runtime store. The
 * local runtime is addressable by its own store session id, or by the stable
 * `'runtime'` alias the mode-change binding stamps on its wire event
 * (runtime/services.ts) so a surface can subscribe before it knows the id.
 */
export function createSessionRuntimeControls(deps: {
  readonly config: PermissionModeConfig;
  readonly store: SessionRuntimeStateReader;
  /** Live-turn controls holder an interactive consumer binds; absent = no live-turn verbs. */
  readonly liveTurnHolder?: SessionLiveTurnControlsHolder | undefined;
}): SessionRuntimeControls {
  const LOCAL_RUNTIME_ALIAS = 'runtime';
  return {
    isLocalSession(sessionId: string): boolean {
      const localId = deps.store.getState().session.id;
      return sessionId === LOCAL_RUNTIME_ALIAS || (localId.length > 0 && sessionId === localId);
    },
    getLiveTurnControls(): SessionLiveTurnControls | null {
      return deps.liveTurnHolder?.get() ?? null;
    },
    getPermissionMode(): PermissionMode {
      return deps.config.get('permissions.mode');
    },
    setPermissionMode(mode: PermissionMode): void {
      deps.config.set('permissions.mode', mode);
    },
    getContextUsage(): SessionContextUsage {
      const state = deps.store.getState();
      const usedTokens = state.conversation.estimatedContextTokens;
      const window = state.model.tokenLimits.contextWindow;
      const derived = deriveContextUsage(usedTokens, window);
      return {
        estimatedContextTokens: usedTokens,
        contextWindow: window,
        contextUsagePct: derived.contextUsagePct,
        contextRemainingTokens: derived.contextRemainingTokens,
      };
    },
  };
}

/**
 * Attach the session-runtime handlers to the descriptors already registered
 * (without a handler) from ../method-catalog-control-core.ts's static builtin
 * array. Call once, at RuntimeServices construction time. A missing descriptor
 * is a silent no-op — the same rationale as routes/fleet.ts.
 */
export function registerSessionRuntimeGatewayMethods(
  catalog: GatewayMethodCatalog,
  controls: SessionRuntimeControls,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('sessions.permissionMode.get', createSessionPermissionModeGetHandler(controls));
  attach('sessions.permissionMode.set', createSessionPermissionModeSetHandler(controls));
  attach('sessions.contextUsage.get', createSessionContextUsageGetHandler(controls));
  attach('sessions.toolCalls.cancel', createSessionToolCallCancelHandler(controls));
  attach('sessions.queuedMessages.list', createSessionQueuedMessagesListHandler(controls));
  attach('sessions.queuedMessages.edit', createSessionQueuedMessageEditHandler(controls));
  attach('sessions.queuedMessages.delete', createSessionQueuedMessageDeleteHandler(controls));
}
