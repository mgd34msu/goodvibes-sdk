/**
 * McpRegistry — manages all connected MCP servers.
 *
 * Progressive loading strategy:
 *   - On connect: load tool names and descriptions only.
 *   - On first callTool: fetch full JSON schema for that tool and cache it
 *
 * Tool namespace: mcp:<server-name>:<tool-name>
 */
import { logger } from '../utils/logger.js';
import {
  loadMcpEffectiveConfig,
  removeMcpServerConfig,
  upsertMcpServerConfig,
} from './config.js';
import { McpClient } from './client.js';
import type {
  McpClientNotification,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpProcessSpec,
} from './client.js';
import type { McpToolInfo, McpToolSchema } from './client.js';
import type {
  McpConfigRoots,
  McpConfigScope,
  McpEffectiveConfig,
  McpServerConfig,
} from './config.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEvent } from '../hooks/types.js';
import { McpPermissionManager } from '../runtime/mcp/permissions.js';
import { McpSchemaFreshnessTracker } from '../runtime/mcp/schema-freshness.js';
import type { McpDecisionRecord, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import {
  emitMcpConfigured,
  emitMcpDisconnected,
  emitMcpPolicyUpdated,
  emitMcpSchemaQuarantineApproved,
  emitMcpSchemaQuarantined,
} from '../runtime/emitters/mcp.js';
import type { ConfigManager } from '../config/manager.js';
import { getSandboxConfigSnapshot } from '../runtime/sandbox/manager.js';
import {
  type SandboxSessionRegistry,
} from '../runtime/sandbox/session-registry.js';
import { resolveSandboxCommandPlan } from '../runtime/sandbox/backend.js';
import { summarizeError } from '../utils/error-display.js';

function compactEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export interface RegisteredTool {
  /** Fully-qualified tool name: mcp:<server>:<tool> */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
}

export interface McpReloadServerResult {
  readonly name: string;
  readonly action: 'added' | 'changed' | 'removed' | 'unchanged';
  readonly connected: boolean;
}

export interface McpReloadResult {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly servers: readonly McpReloadServerResult[];
}

function sameServerConfig(a: McpServerConfig | undefined, b: McpServerConfig | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private permissions = new McpPermissionManager();
  private freshness = new McpSchemaFreshnessTracker();
  private runtimeBus: RuntimeEventBus | null = null;
  private sandboxConfigManager: ConfigManager | null = null;
  private sandboxSessions: SandboxSessionRegistry;
  private sandboxSessionByServer = new Map<string, string>();
  private readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;

  constructor(options: {
    readonly hookDispatcher: Pick<HookDispatcher, 'fire'>;
    readonly sandboxSessions: SandboxSessionRegistry;
  }) {
    this.hookDispatcher = options.hookDispatcher;
    this.sandboxSessions = options.sandboxSessions;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  setSandboxRuntime(configManager: ConfigManager, sessions: SandboxSessionRegistry): void {
    this.sandboxConfigManager = configManager;
    this.sandboxSessions = sessions;
  }

  /**
   * connectAll — Load config from .goodvibes/mcp.json and connect to all servers.
   * Errors on individual servers are logged but do not abort the whole startup.
   */
  async connectAll(roots: McpConfigRoots): Promise<void> {
    await this.reload(roots);
  }

  /**
   * connectServer — Connect a single MCP server by config.
   * Exposed for programmatic use (testing, dynamic registration).
   */
  async connectServer(serverConfig: McpServerConfig): Promise<void> {
    this.serverConfigs.set(serverConfig.name, serverConfig);
    await this._connectServer(serverConfig);
  }

  async reload(roots: McpConfigRoots): Promise<McpReloadResult> {
    const effective = loadMcpEffectiveConfig(roots);
    return this.applyConfig(effective.servers.map((entry) => entry.server));
  }

  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig {
    return loadMcpEffectiveConfig(roots);
  }

  async upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }> {
    const written = upsertMcpServerConfig(roots, scope, serverConfig);
    return { path: written.path, reload: await this.reload(roots) };
  }

  async removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }> {
    const written = removeMcpServerConfig(roots, scope, serverName);
    return { path: written.path, removed: written.removed, reload: await this.reload(roots) };
  }

  async applyConfig(serverConfigs: readonly McpServerConfig[]): Promise<McpReloadResult> {
    const next = new Map(serverConfigs.map((serverConfig) => [serverConfig.name, serverConfig] as const));
    const results: McpReloadServerResult[] = [];
    let added = 0;
    let changed = 0;
    let removed = 0;
    let unchanged = 0;

    for (const name of [...this.serverConfigs.keys()]) {
      if (next.has(name)) continue;
      await this.disconnectServer(name, 'config-removed');
      this.serverConfigs.delete(name);
      removed += 1;
      results.push({ name, action: 'removed', connected: false });
    }

    for (const [name, serverConfig] of next) {
      const previous = this.serverConfigs.get(name);
      if (previous && sameServerConfig(previous, serverConfig)) {
        unchanged += 1;
        const client = this.clients.get(name);
        if (!client?.isConnected) {
          await this._connectServer(serverConfig);
        }
        results.push({ name, action: 'unchanged', connected: this.clients.get(name)?.isConnected ?? false });
        continue;
      }
      if (previous) {
        await this.disconnectServer(name, 'config-changed');
        changed += 1;
      } else {
        added += 1;
      }
      this.serverConfigs.set(name, serverConfig);
      await this._connectServer(serverConfig);
      results.push({
        name,
        action: previous ? 'changed' : 'added',
        connected: this.clients.get(name)?.isConnected ?? false,
      });
    }

    return { added, changed, removed, unchanged, servers: results };
  }

  /**
   * listAllTools — Return all registered tools (name + description) from all connected servers.
   * Only loads tool names and descriptions — full schemas are NOT fetched here.
   */
  async listAllTools(): Promise<RegisteredTool[]> {
    const results: RegisteredTool[] = [];
    for (const [serverName, client] of this.clients) {
      if (!client.isConnected) continue;
      try {
        const tools: McpToolInfo[] = await client.listTools();
        for (const tool of tools) {
          results.push({
            qualifiedName: `mcp:${serverName}:${tool.name}`,
            serverName,
            toolName: tool.name,
            description: tool.description,
          });
        }
      } catch (err) {
        logger.info('McpRegistry: failed to list tools from server', { server: serverName, err: summarizeError(err) });
      }
    }
    return results;
  }

  /**
   * getToolSchema — Fetch full JSON schema for a qualified tool name.
   * Triggers lazy schema load and caches within McpClient.
   */
  async getToolSchema(qualifiedName: string): Promise<McpToolSchema | null> {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) return null;
    const client = this.clients.get(parsed.serverName);
    if (!client || !client.isConnected) return null;
    return client.getToolSchema(parsed.toolName);
  }

  /**
   * callTool — Execute a tool by its qualified name.
   * Fetches the full schema on first use.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = this._parseQualifiedName(qualifiedName);
    if (!parsed) {
      throw new Error(`McpRegistry: invalid qualified tool name '${qualifiedName}'`);
    }
    const client = this.clients.get(parsed.serverName);
    if (!client) {
      throw new Error(`McpRegistry: no server named '${parsed.serverName}'`);
    }
    if (!client.isConnected) {
      throw new Error(`McpRegistry: server '${parsed.serverName}' is not connected`);
    }
    if (this.freshness.isQuarantined(parsed.serverName)) {
      const record = this.freshness.getRecord(parsed.serverName);
      throw new Error(
        `MCP call '${qualifiedName}' blocked: schema quarantined (${record?.quarantine?.reason ?? 'unknown'})${record?.quarantine?.detail ? ` — ${record.quarantine.detail}` : ''}`,
      );
    }

    const permission = this.permissions.evaluateToolCall(parsed.serverName, parsed.toolName, args);
    if (permission.verdict === 'deny') {
      throw new Error(`MCP call '${qualifiedName}' denied: ${permission.reason}`);
    }
    if (permission.verdict === 'ask') {
      throw new Error(`MCP call '${qualifiedName}' requires approval: ${permission.reason}`);
    }

    // Pre:mcp:call hook
    const dispatcher = this.hookDispatcher;
    const preEvent: HookEvent = {
      path: 'Pre:mcp:call',
      phase: 'Pre',
      category: 'mcp',
      specific: 'call',
      sessionId: '', timestamp: Date.now(),
      payload: { tool: qualifiedName, args },
    };
    const preResult = await dispatcher.fire(preEvent).catch((error) => {
      throw new Error(`MCP call '${qualifiedName}' pre-call hook failed: ${summarizeError(error)}`);
    });
    if (preResult.ok === false) {
      throw new Error(`MCP call '${qualifiedName}' pre-call hook failed: ${preResult.error ?? 'unknown error'}`);
    }
    if (preResult.decision === 'deny') {
      throw new Error(`MCP call '${qualifiedName}' denied by hook: ${(preResult as { reason?: string }).reason ?? 'no reason'}`);
    }

    try {
      const result = await client.callTool(parsed.toolName, args);
      this.freshness.markFresh(parsed.serverName);
      // Post:mcp:call hook (fire-and-forget)
      const postEvent: HookEvent = {
        path: 'Post:mcp:call',
        phase: 'Post',
        category: 'mcp',
        specific: 'call',
        sessionId: '', timestamp: Date.now(),
        payload: { tool: qualifiedName, args },
      };
      dispatcher.fire(postEvent).catch((err: unknown) => { logger.warn('Post:mcp:call hook error', { error: summarizeError(err) }); });
      return result;
    } catch (err) {
      this.freshness.markFailed(parsed.serverName, summarizeError(err));
      // Fail:mcp:call hook (fire-and-forget)
      const failEvent: HookEvent = {
        path: 'Fail:mcp:call',
        phase: 'Fail',
        category: 'mcp',
        specific: 'call',
        sessionId: '', timestamp: Date.now(),
        payload: { tool: qualifiedName, args, error: summarizeError(err) },
      };
      dispatcher.fire(failEvent).catch((hookErr: unknown) => { logger.warn('Fail:mcp:call hook error', { error: String(hookErr) }); });
      throw err;
    }
  }

  /**
   * disconnectAll — Stop all connected MCP server processes.
   */
  async disconnectAll(): Promise<void> {
    // Lifecycle:mcp:disconnected hooks (fire-and-forget for each server)
    const dispatcher = this.hookDispatcher;
    for (const name of this.clients.keys()) {
      const disconnectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:disconnected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'disconnected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      dispatcher.fire(disconnectedEvent).catch((err: unknown) => { logger.warn('Lifecycle:mcp:disconnected hook error', { error: summarizeError(err) }); });
    }
    await Promise.allSettled(
      Array.from(this.clients.values()).map((client) => client.disconnect()),
    );
    this.clients.clear();
    for (const sessionId of this.sandboxSessionByServer.values()) {
      this.sandboxSessions.stop(sessionId);
    }
    this.sandboxSessionByServer.clear();
  }

  async disconnectServer(serverName: string, reason = 'manual'): Promise<boolean> {
    const client = this.clients.get(serverName);
    if (!client) return false;
    await client.disconnect();
    this.clients.delete(serverName);
    const sessionId = this.sandboxSessionByServer.get(serverName);
    if (sessionId) {
      this.sandboxSessions.stop(sessionId);
      this.sandboxSessionByServer.delete(serverName);
    }
    if (this.runtimeBus) {
      emitMcpDisconnected(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:disconnected`,
        source: 'mcp-registry',
      }, { serverId: serverName, reason, willRetry: false });
    }
    const disconnectedEvent: HookEvent = {
      path: 'Lifecycle:mcp:disconnected',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'disconnected',
      sessionId: '',
      timestamp: Date.now(),
      payload: { server: serverName, reason },
    };
    this.hookDispatcher.fire(disconnectedEvent).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:disconnected hook error', { error: summarizeError(err) });
    });
    return true;
  }

  /**
   * getClient — Get the McpClient for a given server name (for advanced use).
   */
  getClient(serverName: string): McpClient | undefined {
    return this.clients.get(serverName);
  }

  /** Connected server names. */
  get serverNames(): string[] {
    return Array.from(new Set([...this.serverConfigs.keys(), ...this.clients.keys()])).sort();
  }

  /**
   * listServers — Return status info for all known servers (connected or not).
   */
  listServers(): Array<{ name: string; connected: boolean }> {
    return this.serverNames.map((name) => ({
      name,
      connected: this.clients.get(name)?.isConnected ?? false,
    }));
  }

  listServerSecurity(): Array<{
    name: string;
    connected: boolean;
    role: import('../runtime/mcp/types.js').McpServerRole;
    trustMode: import('../runtime/mcp/types.js').McpTrustMode;
    allowedPaths: string[];
    allowedHosts: string[];
    schemaFreshness: SchemaFreshness;
    quarantineReason?: QuarantineReason | undefined;
    quarantineDetail?: string | undefined;
    quarantineApprovedBy?: string | undefined;
  }> {
    return this.listServers().map((server) => {
      const permissions = this.permissions.getServerPermissions(server.name);
      const freshnessRecord = this.freshness.getRecord(server.name);
      return {
        name: server.name,
        connected: server.connected,
        role: permissions?.profile.role ?? 'general',
        trustMode: permissions?.profile.mode ?? 'ask-on-risk',
        allowedPaths: permissions?.profile.allowedPaths ?? [],
        allowedHosts: permissions?.profile.allowedHosts ?? [],
        schemaFreshness: this.freshness.getFreshness(server.name),
        quarantineReason: freshnessRecord?.quarantine?.reason,
        quarantineDetail: freshnessRecord?.quarantine?.detail,
        quarantineApprovedBy: freshnessRecord?.quarantine?.overrideAcknowledgedBy,
      };
    });
  }

  listServerSandboxBindings(): Array<{
    name: string;
    sessionId?: string | undefined;
    profileId?: 'mcp-shared' | 'mcp-per-server' | undefined;
    state?: import('../runtime/sandbox/types.js').SandboxSessionState | undefined;
    backend?: import('../runtime/sandbox/types.js').SandboxResolvedBackend | import('../runtime/sandbox/types.js').SandboxVmBackend | undefined;
    startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
  }> {
    return this.serverNames.map((name) => {
      const sessionId = this.sandboxSessionByServer.get(name);
      const session = sessionId ? this.sandboxSessions.get(sessionId) : null;
      return {
        name,
        sessionId: sessionId ?? undefined,
        profileId: session?.profileId === 'mcp-shared' || session?.profileId === 'mcp-per-server'
          ? session.profileId
          : undefined,
        state: session?.state,
        backend: session?.resolvedBackend ?? session?.backend,
        startupStatus: session?.startupStatus,
      };
    });
  }

  setServerTrustMode(serverName: string, mode: import('../runtime/mcp/types.js').McpTrustMode): void {
    this.permissions.setTrustMode(serverName, mode);
    this._emitPolicyUpdate(serverName);
  }

  setServerRole(serverName: string, role: import('../runtime/mcp/types.js').McpServerRole): void {
    this.permissions.setServerRole(serverName, role);
    this._emitPolicyUpdate(serverName);
  }

  listRecentSecurityDecisions(limit = 8): McpDecisionRecord[] {
    return this.permissions.listRecentDecisions(limit);
  }

  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void {
    this.freshness.markQuarantined(serverName, reason, detail);
    if (this.runtimeBus) {
      emitMcpSchemaQuarantined(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-quarantined`,
        source: 'mcp-registry',
      }, { serverId: serverName, reason, ...(detail ? { detail } : {}) });
    }
  }

  approveSchemaQuarantine(serverName: string, operatorId: string): void {
    this.freshness.approveQuarantine(serverName, operatorId);
    if (this.runtimeBus) {
      emitMcpSchemaQuarantineApproved(this.runtimeBus, {
        sessionId: 'mcp-registry',
        traceId: `mcp-registry:${serverName}:schema-approved`,
        source: 'mcp-registry',
      }, { serverId: serverName, operatorId });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _connectServer(serverConfig: McpServerConfig): Promise<void> {
    const { name } = serverConfig;
    const existing = this.clients.get(name);
    if (existing?.isConnected) {
      logger.info('McpRegistry: server already registered', { name });
      return;
    }
    if (existing) {
      await this.disconnectServer(name, 'reconnect');
    }
    let sandboxSessionId: string | null = null;
    let processSpec: McpProcessSpec | undefined;
    if (this.sandboxConfigManager) {
      const resolved = await this._resolveSandboxProcessSpec(serverConfig);
      sandboxSessionId = resolved?.sessionId ?? null;
      processSpec = resolved?.processSpec;
    }
    const client = new McpClient(serverConfig, {
      ...(processSpec ? { processSpec } : {}),
      onNotification: (notification) => this._handleClientNotification(notification),
      onServerRequest: (request) => this._handleClientServerRequest(request),
      onUnhandledResponse: (response) => this._handleClientUnhandledResponse(response),
    });
    this.freshness.registerServer(name);
    try {
      await client.connect();
      this.permissions.registerServer(name, 'standard', {
        role: serverConfig.role ?? 'general',
        mode: serverConfig.trustMode ?? 'ask-on-risk',
        allowedPaths: serverConfig.allowedPaths ?? [],
        allowedHosts: serverConfig.allowedHosts ?? [],
      });
      this.clients.set(name, client);
      if (sandboxSessionId) {
        this.sandboxSessionByServer.set(name, sandboxSessionId);
      }
      this.freshness.markFresh(name);
      logger.info('McpRegistry: server connected', { name });
      if (this.runtimeBus) {
        emitMcpConfigured(this.runtimeBus, {
          sessionId: 'mcp-registry',
          traceId: `mcp-registry:${name}:configured`,
          source: 'mcp-registry',
        }, {
          serverId: name,
          transport: 'stdio',
          role: serverConfig.role ?? 'general',
          trustMode: serverConfig.trustMode ?? 'ask-on-risk',
          allowedPaths: serverConfig.allowedPaths ?? [],
          allowedHosts: serverConfig.allowedHosts ?? [],
        });
      }
      // Lifecycle:mcp:connected hook (fire-and-forget)
      const connectedEvent: HookEvent = {
        path: 'Lifecycle:mcp:connected',
        phase: 'Lifecycle',
        category: 'mcp',
        specific: 'connected',
        sessionId: '', timestamp: Date.now(),
        payload: { server: name },
      };
      this.hookDispatcher.fire(connectedEvent).catch((err: unknown) => { logger.warn('Lifecycle:mcp:connected hook error', { error: summarizeError(err) }); });
    } catch (err) {
      if (sandboxSessionId) {
        this.sandboxSessions.stop(sandboxSessionId);
        this.sandboxSessionByServer.delete(name);
      }
      this.freshness.markFailed(name, summarizeError(err));
      logger.error('McpRegistry: failed to connect server', { name, err: summarizeError(err) });
      // Don't register the client — it's not usable
    }
  }

  private async _resolveSandboxProcessSpec(
    serverConfig: McpServerConfig,
  ): Promise<{ sessionId: string; processSpec: McpProcessSpec } | null> {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return null;
    const sandbox = getSandboxConfigSnapshot(configManager);
    if (sandbox.mcpIsolation === 'disabled') return null;

    const profileId = this._selectSandboxProfile(serverConfig);
    const label = `${serverConfig.name} MCP`;
    const session = await this.sandboxSessions.start(profileId, label, configManager);
    if (!session.launchPlan) {
      throw new Error(`Sandbox session ${session.id} for MCP server '${serverConfig.name}' is missing a launch plan.`);
    }
    const resolvedPlan = resolveSandboxCommandPlan(
      session.launchPlan,
      serverConfig.command,
      serverConfig.args ?? [],
      configManager,
    );
    return {
      sessionId: session.id,
      processSpec: {
        command: resolvedPlan.command,
        args: [...resolvedPlan.args],
        env: compactEnv({ ...(serverConfig.env ?? {}), ...(resolvedPlan.env ?? {}) }),
        cwd: session.launchPlan.workspaceRoot,
        summary: resolvedPlan.summary,
        sandboxSessionId: session.id,
      },
    };
  }

  private _selectSandboxProfile(serverConfig: McpServerConfig): 'mcp-shared' | 'mcp-per-server' {
    const configManager = this.sandboxConfigManager;
    if (!configManager) return 'mcp-shared';
    const sandbox = getSandboxConfigSnapshot(configManager);
    switch (sandbox.mcpIsolation) {
      case 'per-server-vm':
        return 'mcp-per-server';
      case 'shared-vm':
        return 'mcp-shared';
      case 'hybrid':
        return this._requiresDedicatedMcpSandbox(serverConfig) ? 'mcp-per-server' : 'mcp-shared';
      case 'disabled':
      default:
        return 'mcp-shared';
    }
  }

  private _requiresDedicatedMcpSandbox(serverConfig: McpServerConfig): boolean {
    return Boolean(
      (serverConfig.allowedHosts?.length ?? 0) > 0
      || (serverConfig.allowedPaths?.length ?? 0) > 0
      || serverConfig.role === 'automation'
      || serverConfig.role === 'browser'
      || serverConfig.role === 'ops'
      || serverConfig.role === 'remote',
    );
  }

  private _handleClientNotification(notification: McpClientNotification): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:notification',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'notification',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: notification.serverName,
        method: notification.method,
        ...(notification.params !== undefined ? { params: notification.params } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:notification hook error', { error: summarizeError(err) });
    });
  }

  private _handleClientServerRequest(request: McpClientServerRequest): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:server_request',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'server_request',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: request.serverName,
        id: request.id,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:server_request hook error', { error: summarizeError(err) });
    });
  }

  private _handleClientUnhandledResponse(response: McpClientUnhandledResponse): void {
    const event: HookEvent = {
      path: 'Lifecycle:mcp:unmatched_response',
      phase: 'Lifecycle',
      category: 'mcp',
      specific: 'unmatched_response',
      sessionId: '',
      timestamp: Date.now(),
      payload: {
        server: response.serverName,
        id: response.id,
        hasError: response.hasError,
        ...(response.error ? { error: response.error } : {}),
      },
    };
    this.hookDispatcher.fire(event).catch((err: unknown) => {
      logger.warn('Lifecycle:mcp:unmatched_response hook error', { error: summarizeError(err) });
    });
  }

  /**
   * Parse mcp:<server>:<tool> qualified name.
   * Returns null if the name doesn't match the expected format.
   */
  private _parseQualifiedName(qualifiedName: string): { serverName: string; toolName: string } | null {
    const parts = qualifiedName.split(':');
    if (parts.length < 3 || parts[0]! !== 'mcp') return null;
    // serverName is parts[1], toolName is the rest joined (tools can have colons)
    const serverName = parts[1]!;
    const toolName = parts.slice(2).join(':');
    if (!serverName || !toolName) return null;
    return { serverName, toolName };
  }

  private _emitPolicyUpdate(serverName: string): void {
    if (!this.runtimeBus) return;
    const permissions = this.permissions.getServerPermissions(serverName);
    if (!permissions) return;
    emitMcpPolicyUpdated(this.runtimeBus, {
      sessionId: 'mcp-registry',
      traceId: `mcp-registry:${serverName}:policy`,
      source: 'mcp-registry',
    }, {
      serverId: serverName,
      role: permissions.profile.role,
      trustMode: permissions.profile.mode,
      allowedPaths: [...permissions.profile.allowedPaths],
      allowedHosts: [...permissions.profile.allowedHosts],
    });
  }
}
