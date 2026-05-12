import type { RegisteredTool } from './registry.js';
import type { McpConfigRoots, McpConfigScope, McpEffectiveConfig, McpServerConfig } from './config.js';
import type { McpReloadResult } from './registry.js';
import type { McpDecisionRecord, McpServerRole, McpTrustMode, QuarantineReason, SchemaFreshness } from '../runtime/mcp/types.js';

export interface McpServerRecord {
  readonly name: string;
  readonly connected: boolean;
}

export interface McpServerSecurityRecord {
  readonly name: string;
  readonly connected: boolean;
  readonly role: McpServerRole;
  readonly trustMode: McpTrustMode;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly schemaFreshness: SchemaFreshness;
  readonly quarantineReason?: QuarantineReason | undefined;
  readonly quarantineDetail?: string | undefined;
  readonly quarantineApprovedBy?: string | undefined;
}

export interface McpSandboxBindingRecord {
  readonly name: string;
  readonly sessionId?: string | undefined;
  readonly profileId?: 'mcp-shared' | 'mcp-per-server' | undefined;
  readonly state?: import('../runtime/sandbox/types.js').SandboxSessionState | undefined;
  readonly backend?: import('../runtime/sandbox/types.js').SandboxResolvedBackend | import('../runtime/sandbox/types.js').SandboxVmBackend | undefined;
  readonly startupStatus?: 'verified' | 'planned' | 'failed' | undefined;
}

export interface McpApi {
  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig;
  reload(roots: McpConfigRoots): Promise<McpReloadResult>;
  upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }>;
  removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }>;
  listServerNames(): readonly string[];
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

export interface McpApiRegistry {
  readonly serverNames: readonly string[];
  getEffectiveConfig(roots: McpConfigRoots): McpEffectiveConfig;
  reload(roots: McpConfigRoots): Promise<McpReloadResult>;
  upsertServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverConfig: McpServerConfig,
  ): Promise<{ readonly path: string; readonly reload: McpReloadResult }>;
  removeServerConfig(
    roots: McpConfigRoots,
    scope: McpConfigScope,
    serverName: string,
  ): Promise<{ readonly path: string; readonly removed: boolean; readonly reload: McpReloadResult }>;
  listServers(): readonly McpServerRecord[];
  listServerSecurity(): readonly McpServerSecurityRecord[];
  listServerSandboxBindings(): readonly McpSandboxBindingRecord[];
  listRecentSecurityDecisions(limit?: number): readonly McpDecisionRecord[];
  listAllTools(): Promise<readonly RegisteredTool[]>;
  setServerTrustMode(serverName: string, mode: McpTrustMode): void;
  setServerRole(serverName: string, role: McpServerRole): void;
  quarantineSchema(serverName: string, reason: QuarantineReason, detail?: string): void;
  approveSchemaQuarantine(serverName: string, operatorId: string): void;
}

export function createMcpApi(registry: McpApiRegistry): McpApi {
  return {
    getEffectiveConfig(roots) {
      return registry.getEffectiveConfig(roots);
    },
    reload(roots) {
      return registry.reload(roots);
    },
    upsertServerConfig(roots, scope, serverConfig) {
      return registry.upsertServerConfig(roots, scope, serverConfig);
    },
    removeServerConfig(roots, scope, serverName) {
      return registry.removeServerConfig(roots, scope, serverName);
    },
    listServerNames(): readonly string[] {
      return registry.serverNames;
    },
    listServers(): readonly McpServerRecord[] {
      return registry.listServers();
    },
    listServerSecurity() {
      return registry.listServerSecurity();
    },
    listSandboxBindings() {
      return registry.listServerSandboxBindings();
    },
    listRecentSecurityDecisions(limit = 8) {
      return registry.listRecentSecurityDecisions(limit);
    },
    listAllTools() {
      return registry.listAllTools();
    },
    setServerTrustMode(serverName, mode) {
      registry.setServerTrustMode(serverName, mode);
    },
    setServerRole(serverName, role) {
      registry.setServerRole(serverName, role);
    },
    quarantineSchema(serverName, reason, detail) {
      registry.quarantineSchema(serverName, reason, detail);
    },
    approveSchemaQuarantine(serverName, operatorId) {
      registry.approveSchemaQuarantine(serverName, operatorId);
    },
  };
}
