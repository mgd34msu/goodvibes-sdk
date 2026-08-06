/**
 * routes/hosted-sessions.ts — the handlers behind `sessions.hosted.*`.
 *
 * Thin on purpose: argument reading and error mapping. Everything a hosted
 * session IS lives in platform/hosted-sessions, so the verbs and the engine
 * cannot drift into two ideas of what create/attach/detach/kill mean.
 *
 * Error mapping is the part worth reading. Each of the engine's refusals has a
 * distinct wire shape, because "there is no such session", "that session ended
 * and here is why", "the path you gave is not absolute" and "you are at the
 * configured cap" want four different reactions from a client, and collapsing
 * them into one 400 is how a caller ends up retrying the one thing that will
 * never work.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import {
  HostedSessionArgumentError,
  HostedSessionLimitError,
  HostedSessionNotFoundError,
  HostedSessionUnavailableError,
} from '../../hosted-sessions/manager.js';
import type { HostedSessionAttachment } from '../../hosted-sessions/manager.js';
import type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionRecord,
} from '../../hosted-sessions/types.js';

/**
 * The engine surface these verbs need. Declared here rather than importing the
 * class so a test drives the routes with a stand-in, and so the routes depend
 * on five methods instead of the whole engine.
 */
export interface HostedSessionVerbService {
  create(input: CreateHostedSessionInput): Promise<HostedSessionRecord>;
  attach(
    sessionId: string,
    clientId: string,
    options?: { readonly leaseMs?: number | undefined },
  ): Promise<HostedSessionAttachment>;
  detach(sessionId: string, clientId: string): Promise<HostedSessionRecord>;
  kill(sessionId: string): Promise<HostedSessionRecord>;
  list(options?: { readonly includeTerminated?: boolean | undefined }): readonly HostedSessionRecord[];
}

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayVerbError(`Invalid ${field}: expected a string`, 'INVALID_ARGUMENT', 400, field);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalPositiveNumber(params: Record<string, unknown>, field: string): number | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GatewayVerbError(`Invalid ${field}: expected a positive number of milliseconds`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function optionalDetachPolicy(params: Record<string, unknown>): HostedDetachPolicy | undefined {
  const value = params['detachPolicy'];
  if (value === undefined || value === null) return undefined;
  if (value !== 'kill' && value !== 'survive') {
    throw new GatewayVerbError(
      'Invalid detachPolicy: expected kill or survive',
      'INVALID_ARGUMENT',
      400,
      'detachPolicy',
    );
  }
  return value;
}

/** Map an engine refusal onto the wire shape a client can act on. */
export function toGatewayVerbError(error: unknown): never {
  if (error instanceof GatewayVerbError) throw error;
  if (error instanceof HostedSessionNotFoundError) {
    // SESSION_NOT_FOUND, not a hosted-specific spelling: it is the same
    // condition the rest of the session surface reports under that code, and
    // clients already branch on it. A second word for "no session with this id"
    // only means the branch that handles it misses half the cases.
    throw new GatewayVerbError(error.message, 'SESSION_NOT_FOUND', 404);
  }
  if (error instanceof HostedSessionUnavailableError) {
    // 409, not 404: the session exists and the caller can read why it cannot
    // serve this request. A 404 would invite a retry against an id that is
    // perfectly real.
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_UNAVAILABLE', 409);
  }
  if (error instanceof HostedSessionLimitError) {
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_LIMIT_REACHED', 429);
  }
  if (error instanceof HostedSessionArgumentError) {
    throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400, 'workspaceRoot');
  }
  throw error;
}

export function createHostedSessionCreateHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const detachPolicy = optionalDetachPolicy(params);
    const title = optionalString(params, 'title');
    const modelId = optionalString(params, 'modelId');
    const initialPrompt = optionalString(params, 'initialPrompt');
    const clientId = optionalString(params, 'clientId');
    // The surface the caller is creating this session FOR. It travels with the
    // create call because the host cannot infer it: every client reaches the
    // daemon the same way, so a session created by the agent and a session
    // created by the TUI are indistinguishable at this seam. Without it the
    // session took the HOST's identity and resolved the wrong surface's
    // client-owned settings for its whole life.
    const originSurface = optionalString(params, 'originSurface');
    try {
      const session = await service.create({
        workspaceRoot: requireString(params, 'workspaceRoot'),
        ...(title === undefined ? {} : { title }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(detachPolicy === undefined ? {} : { detachPolicy }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(originSurface === undefined ? {} : { originSurface }),
      });
      return { session };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionAttachHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const leaseMs = optionalPositiveNumber(params, 'leaseMs');
    try {
      return await service.attach(
        requireString(params, 'sessionId'),
        requireString(params, 'clientId'),
        ...(leaseMs === undefined ? [] : [{ leaseMs }]),
      );
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionDetachHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      return { session: await service.detach(requireString(params, 'sessionId'), requireString(params, 'clientId')) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionKillHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      return { session: await service.kill(requireString(params, 'sessionId')) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionListHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const includeTerminated = params['includeTerminated'] === true;
    return { sessions: service.list({ includeTerminated }) };
  };
}

/** Every verb this module owns, in the order a client meets them. */
export const HOSTED_SESSION_METHOD_IDS: readonly string[] = [
  'sessions.hosted.create',
  'sessions.hosted.attach',
  'sessions.hosted.detach',
  'sessions.hosted.kill',
  'sessions.hosted.list',
];

/**
 * Attach the hosted-session handlers to their descriptors. A missing descriptor
 * is a silent no-op, matching every other route group here.
 */
export function registerHostedSessionGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: HostedSessionVerbService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (!descriptor) return;
    // An engine arriving after `refuseHostedSessionGatewayMethods` ran undoes
    // that refusal: a registered handler is the authority on whether a verb
    // works, and leaving the flag set would refuse a call this daemon can serve.
    const invokable = descriptor.invokable === false ? { ...descriptor, invokable: true } : descriptor;
    catalog.register(invokable, handler, { replace: true });
  };
  attach('sessions.hosted.create', createHostedSessionCreateHandler(service));
  attach('sessions.hosted.attach', createHostedSessionAttachHandler(service));
  attach('sessions.hosted.detach', createHostedSessionDetachHandler(service));
  attach('sessions.hosted.kill', createHostedSessionKillHandler(service));
  attach('sessions.hosted.list', createHostedSessionListHandler(service));
}

/**
 * Say, in the catalog, that this daemon hosts nothing.
 *
 * The descriptors are builtins: they are present whether or not a product
 * stated how a hosted session's workspace floor is built. With no engine there
 * is no handler either, and dispatch fell through to the branch for a verb with
 * neither handler nor route — a 501 whose body carried no code, and a plain
 * `Error` for anyone calling `catalog.invoke()` directly, which is a 500. Both
 * read as "this daemon is broken" for a capability that is simply off.
 *
 * Marking them uninvokable makes the refusal the one the catalog already
 * promises for a cataloged-but-not-dispatchable verb: an honest 400 with
 * `NOT_INVOKABLE`, before any handler lookup, on every path.
 */
export function refuseHostedSessionGatewayMethods(catalog: GatewayMethodCatalog): void {
  for (const id of HOSTED_SESSION_METHOD_IDS) {
    const descriptor = catalog.get(id);
    if (!descriptor || descriptor.invokable === false) continue;
    catalog.register({ ...descriptor, invokable: false }, undefined, { replace: true });
  }
}
