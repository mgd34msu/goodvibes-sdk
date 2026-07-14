/**
 * routes/acp.ts
 *
 * Handlers for the acp.* verbs over the AcpHostService: read-only discovery of
 * installed third-party coding agents, and the one-act spawn that hosts one as
 * a daemon session / fleet row. Same registration pattern as push/pairing.
 */
import { existsSync, statSync } from 'node:fs';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { AcpHostService, DiscoveredAcpAgent } from '../../acp/host.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

export interface AcpGatewayDeps {
  readonly host: Pick<AcpHostService, 'spawnAgent' | 'list'>;
  /** Discovery seam (the real discoverAcpAgents in production; injectable for tests). */
  readonly discover: () => DiscoveredAcpAgent[];
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('ACP verbs require an authenticated principal', 'UNAUTHENTICATED', 401);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`Missing or invalid ${field}`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}

function createAgentsListHandler(deps: AcpGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    return { agents: deps.discover() };
  };
}

function createSessionsCreateHandler(deps: AcpGatewayDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const agentId = requireString(params.agentId, 'agentId');
    const cwd = requireString(params.cwd, 'cwd');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new GatewayVerbError(`cwd is not an existing directory: ${cwd}`, 'INVALID_ARGUMENT', 400);
    }
    const agent = deps.discover().find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new GatewayVerbError(`No installed agent with id "${agentId}" — see acp.agents.list`, 'AGENT_NOT_FOUND', 404);
    }
    const hosted = await deps.host.spawnAgent({
      agent,
      cwd,
      title: typeof params.title === 'string' && params.title.trim().length > 0 ? params.title : undefined,
      prompt: typeof params.prompt === 'string' && params.prompt.trim().length > 0 ? params.prompt : undefined,
    });
    // A handshake failure is an HONEST OUTCOME (structured error on the
    // record), not a transport throw — the surface renders which binary
    // failed at which stage.
    return { hosted, started: hosted.state !== 'failed' };
  };
}

const ACP_HANDLER_FACTORIES: Readonly<Record<string, (deps: AcpGatewayDeps) => GatewayMethodHandler>> = {
  'acp.agents.list': createAgentsListHandler,
  'acp.sessions.create': createSessionsCreateHandler,
};

/** Attach the acp.* handlers to their cataloged descriptors. Missing descriptors are silent no-ops. */
export function registerAcpGatewayMethods(catalog: GatewayMethodCatalog, deps: AcpGatewayDeps): void {
  for (const [methodId, factory] of Object.entries(ACP_HANDLER_FACTORIES)) {
    const descriptor = catalog.get(methodId);
    if (descriptor) {
      catalog.register(descriptor, factory(deps), { replace: true });
    }
  }
}
