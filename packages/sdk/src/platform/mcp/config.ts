/**
 * MCP server configuration — scans multiple locations in precedence order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';
import type { ShellPathService } from '../runtime/shell-paths.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';

export interface McpServerConfig {
  /** Unique server name, used as namespace prefix: mcp:<name>:<tool> */
  name: string;
  /** Executable command to start a stdio MCP server process. Exactly one of command/url. */
  command?: string | undefined;
  /** Streamable HTTP endpoint of a remote MCP server. Exactly one of command/url. */
  url?: string | undefined;
  /** Arguments to pass to the command */
  args?: string[] | undefined;
  /** Optional environment variables to merge with process.env */
  env?: Record<string, string> | undefined;
  /** Optional role used by runtime coherence checks. */
  role?: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote' | undefined;
  /** Optional initial trust mode for the runtime MCP trust layer. */
  trustMode?: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked' | undefined;
  /** Optional allowed path prefixes for filesystem-oriented tools. */
  allowedPaths?: string[] | undefined;
  /** Optional allowed network hostnames for network-oriented tools. */
  allowedHosts?: string[] | undefined;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export type McpConfigRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
export type McpConfigScope = 'project' | 'global';

export interface McpConfigLocation {
  readonly scope: McpConfigScope | 'external';
  readonly kind: 'global-xdg' | 'global-dotdir' | 'claude-desktop' | 'project-mcp' | 'project-goodvibes';
  readonly path: string;
  readonly writable: boolean;
}

export interface McpServerConfigEntry {
  readonly server: McpServerConfig;
  readonly source: McpConfigLocation;
}

export interface McpEffectiveConfig {
  readonly servers: readonly McpServerConfigEntry[];
  readonly locations: readonly McpConfigLocation[];
}


function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeServerConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url : undefined;
  if (!command && !url) return null;
  return {
    name,
    command,
    url,
    args: optionalStringArray(raw.args) ?? [],
    env: optionalStringRecord(raw.env),
    role: typeof raw.role === 'string' ? raw.role as McpServerConfig['role'] : undefined,
    trustMode: typeof raw.trustMode === 'string' ? raw.trustMode as McpServerConfig['trustMode'] : undefined,
    allowedPaths: optionalStringArray(raw.allowedPaths),
    allowedHosts: optionalStringArray(raw.allowedHosts),
  };
}

export function getMcpConfigLocations(roots: McpConfigRoots): readonly McpConfigLocation[] {
  const cwd = roots.workingDirectory;
  const home = roots.homeDirectory;
  return [
    {
      scope: 'global',
      kind: 'global-xdg',
      path: join(home, '.config', 'mcp', 'mcp.json'),
      writable: true,
    },
    {
      scope: 'external',
      kind: 'global-dotdir',
      path: join(home, '.mcp', 'mcp.json'),
      writable: false,
    },
    {
      scope: 'external',
      kind: 'claude-desktop',
      path: join(home, '.config', 'claude', 'claude_desktop_config.json'),
      writable: false,
    },
    {
      scope: 'external',
      kind: 'project-mcp',
      path: join(cwd, '.mcp', 'mcp.json'),
      writable: false,
    },
    {
      scope: 'project',
      kind: 'project-goodvibes',
      path: join(cwd, '.goodvibes', 'mcp.json'),
      writable: true,
    },
  ];
}

function writableMcpConfigLocation(roots: McpConfigRoots, scope: McpConfigScope): McpConfigLocation {
  const location = getMcpConfigLocations(roots).find((entry) => entry.scope === scope && entry.writable);
  if (!location) throw new Error(`No writable MCP config location is available for scope '${scope}'.`);
  return location;
}

function parseMcpServers(raw: unknown): McpServerConfig[] | null {
  if (!isRecord(raw)) return null;

  if (isRecord(raw.mcpServers)) {
    const servers: McpServerConfig[] = [];
    for (const [name, value] of Object.entries(raw.mcpServers)) {
      if (!isRecord(value)) continue;
      const server = normalizeServerConfig(name, value);
      if (server) servers.push(server);
    }
    return servers;
  }

  if (isMcpConfig(raw)) return raw.servers.map((server) => ({ ...server }));
  return null;
}

function readMcpConfigAtPath(path: string): McpConfig {
  if (!existsSync(path)) return { servers: [] };
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const servers = parseMcpServers(raw);
  return { servers: servers ?? [] };
}

function assertServerConfig(server: McpServerConfig): void {
  if (!server.name.trim()) throw new Error('MCP server name is required.');
  if (server.name.includes(':') || server.name.includes('/')) {
    throw new Error('MCP server name may not contain ":" or "/".');
  }
  const hasCommand = Boolean(server.command?.trim());
  const hasUrl = Boolean(server.url?.trim());
  if (!hasCommand && !hasUrl) throw new Error('MCP server needs a command (stdio) or a url (HTTP).');
  if (hasCommand && hasUrl) throw new Error('MCP server may set command (stdio) or url (HTTP), not both.');
}

function writeMcpConfigFile(path: string, config: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized = {
    servers: config.servers.map((server) => {
      assertServerConfig(server);
      return {
        name: server.name,
        ...(server.command !== undefined ? { command: server.command } : {}),
        ...(server.url !== undefined ? { url: server.url } : {}),
        ...(server.args !== undefined ? { args: [...server.args] } : {}),
        ...(server.env !== undefined ? { env: { ...server.env } } : {}),
        ...(server.role !== undefined ? { role: server.role } : {}),
        ...(server.trustMode !== undefined ? { trustMode: server.trustMode } : {}),
        ...(server.allowedPaths !== undefined ? { allowedPaths: [...server.allowedPaths] } : {}),
        ...(server.allowedHosts !== undefined ? { allowedHosts: [...server.allowedHosts] } : {}),
      };
    }),
  };
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
}

/**
 * loadMcpConfig - Scan multiple locations in precedence order (later wins).
 * Returns merged config from all found files. Returns empty config on failure.
 */
export function loadMcpConfig(roots: McpConfigRoots): McpConfig {
  return { servers: loadMcpEffectiveConfig(roots).servers.map((entry) => entry.server) };
}

export function loadMcpEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig {
  const locations = getMcpConfigLocations(roots);
  const serversByName = new Map<string, McpServerConfigEntry>();

  for (const location of locations) {
    try {
      if (!existsSync(location.path)) continue;
      const config = readMcpConfigAtPath(location.path);
      for (const server of config.servers) {
        serversByName.set(server.name, { server, source: location });
      }
    } catch (err) {
      logger.warn(`[MCP] Failed to read ${location.path}`, { error: summarizeError(err) });
    }
  }

  return {
    servers: [...serversByName.values()],
    locations,
  };
}

export function loadWritableMcpConfig(roots: McpConfigRoots, scope: McpConfigScope): McpConfig {
  const location = writableMcpConfigLocation(roots, scope);
  return readMcpConfigAtPath(location.path);
}

export function upsertMcpServerConfig(
  roots: McpConfigRoots,
  scope: McpConfigScope,
  server: McpServerConfig,
): { readonly path: string; readonly config: McpConfig } {
  assertServerConfig(server);
  const location = writableMcpConfigLocation(roots, scope);
  const current = readMcpConfigAtPath(location.path);
  const nextServers = current.servers.filter((entry) => entry.name !== server.name);
  nextServers.push({ ...server });
  nextServers.sort((a, b) => a.name.localeCompare(b.name));
  const config = { servers: nextServers };
  writeMcpConfigFile(location.path, config);
  return { path: location.path, config };
}

export function removeMcpServerConfig(
  roots: McpConfigRoots,
  scope: McpConfigScope,
  serverName: string,
): { readonly path: string; readonly removed: boolean; readonly config: McpConfig } {
  if (!serverName.trim()) throw new Error('MCP server name is required.');
  const location = writableMcpConfigLocation(roots, scope);
  const current = readMcpConfigAtPath(location.path);
  const config = { servers: current.servers.filter((entry) => entry.name !== serverName) };
  const removed = config.servers.length !== current.servers.length;
  if (removed || existsSync(location.path)) writeMcpConfigFile(location.path, config);
  return { path: location.path, removed, config };
}

/** Type guard for McpConfig (goodvibes format) */
function isMcpConfig(v: unknown): v is McpConfig {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj['servers'])) return false;
  for (const s of obj['servers']) {
    if (typeof s !== 'object' || s === null) return false;
    const srv = s as Record<string, unknown>;
    if (typeof srv['name'] !== 'string' || !srv['name']) return false;
    const hasCommand = typeof srv['command'] === 'string' && srv['command'].length > 0;
    const hasUrl = typeof srv['url'] === 'string' && srv['url'].length > 0;
    if (!hasCommand && !hasUrl) return false;
    if (srv['command'] !== undefined && typeof srv['command'] !== 'string') return false;
    if (srv['url'] !== undefined && typeof srv['url'] !== 'string') return false;
    if (srv['args'] !== undefined) {
      if (!Array.isArray(srv['args'])) return false;
      if (!srv['args'].every((a: unknown) => typeof a === 'string')) return false;
    }
    if (srv['env'] !== undefined && (typeof srv['env'] !== 'object' || srv['env'] === null)) return false;
    if (srv['role'] !== undefined && typeof srv['role'] !== 'string') return false;
    if (srv['trustMode'] !== undefined && typeof srv['trustMode'] !== 'string') return false;
    if (srv['allowedPaths'] !== undefined && (!Array.isArray(srv['allowedPaths']) || !srv['allowedPaths'].every((a: unknown) => typeof a === 'string'))) return false;
    if (srv['allowedHosts'] !== undefined && (!Array.isArray(srv['allowedHosts']) || !srv['allowedHosts'].every((a: unknown) => typeof a === 'string'))) return false;
  }
  return true;
}
