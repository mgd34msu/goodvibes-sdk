import type { McpRegistry } from '../../mcp/registry.js';
import type {
  McpConfigRoots,
  McpConfigScope,
  McpEffectiveConfig,
  McpServerConfig,
} from '../../mcp/config.js';
import type { JsonRecord } from '../helpers.js';
import { jsonErrorResponse } from './error-response.js';

interface McpRouteContext {
  readonly mcpRegistry: Pick<
    McpRegistry,
    | 'getEffectiveConfig'
    | 'reload'
    | 'upsertServerConfig'
    | 'removeServerConfig'
    | 'listServers'
    | 'listServerSecurity'
    | 'listServerSandboxBindings'
    | 'listAllTools'
  >;
  readonly roots: McpConfigRoots;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) return undefined;
  return Object.fromEntries(entries);
}

function parseScope(value: unknown): McpConfigScope {
  return value === 'global' ? 'global' : 'project';
}

function parseServerConfig(value: unknown): McpServerConfig | Response {
  if (!isRecord(value)) {
    return jsonErrorResponse({ error: 'Missing MCP server config object.' }, { status: 400 });
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    return jsonErrorResponse({ error: 'MCP server name is required.' }, { status: 400 });
  }
  if (typeof value.command !== 'string' || !value.command.trim()) {
    return jsonErrorResponse({ error: 'MCP server command is required.' }, { status: 400 });
  }
  return {
    name: value.name.trim(),
    command: value.command.trim(),
    args: stringArray(value.args) ?? [],
    env: stringRecord(value.env),
    role: typeof value.role === 'string' ? value.role as McpServerConfig['role'] : undefined,
    trustMode: typeof value.trustMode === 'string' ? value.trustMode as McpServerConfig['trustMode'] : undefined,
    allowedPaths: stringArray(value.allowedPaths),
    allowedHosts: stringArray(value.allowedHosts),
  };
}

function redactServer(server: McpServerConfig): Record<string, unknown> {
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    envKeys: Object.keys(server.env ?? {}).sort(),
    role: server.role ?? null,
    trustMode: server.trustMode ?? null,
    allowedPaths: server.allowedPaths ?? [],
    allowedHosts: server.allowedHosts ?? [],
  };
}

function serializeEffectiveConfig(config: McpEffectiveConfig): Record<string, unknown> {
  return {
    locations: config.locations,
    servers: config.servers.map((entry) => ({
      ...redactServer(entry.server),
      source: entry.source,
    })),
  };
}

export async function dispatchMcpRoutes(req: Request, context: McpRouteContext): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/api/mcp/config' && req.method === 'GET') {
    return Response.json(serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)));
  }

  if (pathname === '/api/mcp/servers' && req.method === 'GET') {
    return Response.json({
      servers: context.mcpRegistry.listServers(),
      security: context.mcpRegistry.listServerSecurity(),
      sandboxBindings: context.mcpRegistry.listServerSandboxBindings(),
    });
  }

  if (pathname === '/api/mcp/tools' && req.method === 'GET') {
    return Response.json({ tools: await context.mcpRegistry.listAllTools() });
  }

  if (pathname === '/api/mcp/reload' && req.method === 'POST') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    return Response.json({
      reload: await context.mcpRegistry.reload(context.roots),
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  if (pathname === '/api/mcp/config/servers' && req.method === 'POST') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    const body = await context.parseJsonBody(req);
    if (body instanceof Response) return body;
    const server = parseServerConfig(body.server ?? body);
    if (server instanceof Response) return server;
    const scope = parseScope(body.scope);
    const result = await context.mcpRegistry.upsertServerConfig(context.roots, scope, server);
    return Response.json({
      scope,
      path: result.path,
      removed: false,
      reload: result.reload,
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  const serverMatch = pathname.match(/^\/api\/mcp\/config\/servers\/([^/]+)$/);
  if (serverMatch && req.method === 'DELETE') {
    const admin = context.requireAdmin(req);
    if (admin) return admin;
    const body = await context.parseOptionalJsonBody(req);
    if (body instanceof Response) return body;
    const scope = parseScope(body?.scope ?? url.searchParams.get('scope'));
    const serverName = decodeURIComponent(serverMatch[1]!);
    const result = await context.mcpRegistry.removeServerConfig(context.roots, scope, serverName);
    return Response.json({
      scope,
      path: result.path,
      removed: result.removed,
      reload: result.reload,
      config: serializeEffectiveConfig(context.mcpRegistry.getEffectiveConfig(context.roots)),
    });
  }

  return null;
}
