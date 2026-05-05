import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { autoRegisterProviders } from '../providers/auto-register.js';
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders, scanMcpServers } from '../discovery/index.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { ShellPathService } from './shell-paths.js';
import { summarizeError } from '../utils/error-display.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';

const FALLBACK_MODEL = {
  model: 'openrouter:openrouter/free',
  provider: 'openrouter',
} as const;

export interface RuntimeSelectionState {
  model: string;
  provider: string;
}

export interface HostSystemMessageSink {
  low(message: string): void;
  high(message: string): void;
}

export interface BackgroundProviderDiscoveryOptions {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: RuntimeSelectionState;
  requestRender: () => void;
  restoreRuntimeModel: (providerRegistry: ProviderRegistry, savedModel: string, runtime: RuntimeSelectionState) => void;
  systemMessageRouter: HostSystemMessageSink;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  surfaceRoot: string;
}

export interface BackgroundRuntimeTaskHandle {
  readonly stopped: boolean;
  stop(): void;
}

/**
 * Starts one asynchronous provider discovery pass and returns a handle that
 * prevents late scan results from mutating runtime state after the host stops.
 *
 * The underlying scanner does not currently expose cancellable I/O, so `stop()`
 * is intentionally a state guard rather than a hard abort.
 */
export function startBackgroundProviderDiscovery(
  options: BackgroundProviderDiscoveryOptions,
): BackgroundRuntimeTaskHandle {
  const { configManager, providerRegistry, runtime, requestRender, restoreRuntimeModel, systemMessageRouter, shellPaths, surfaceRoot } = options;
  autoRegisterProviders(providerRegistry);
  let stopped = false;
  const handle: BackgroundRuntimeTaskHandle = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
  };

  const persisted = loadPersistedProviders({ ...shellPaths, surfaceRoot });
  if (persisted.length > 0) {
    try {
      providerRegistry.registerDiscoveredProviders(persisted);
      restoreRuntimeModel(
        providerRegistry,
        configManager.get('provider.model') as string,
        runtime,
      );
      for (const server of persisted) {
        systemMessageRouter.low(
          `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}) — from last session`,
        );
      }
      requestRender();
    } catch (err) {
      logger.warn('[bootstrap] Persisted provider registration failed', {
        error: summarizeError(err),
      });
    }
  }

  scan().then((result) => {
    if (stopped) return;
    const currentModel = configManager.get('provider.model') as string;
    const foundKeys = new Set(result.servers.map((server) => `${server.host}:${server.port}`));
    const persistedKeys = new Set(persisted.map((server) => `${server.host}:${server.port}`));
    const newServers = result.servers.filter((server) => !persistedKeys.has(`${server.host}:${server.port}`));
    const removedServers = persisted.filter((server) => !foundKeys.has(`${server.host}:${server.port}`));

    if (result.servers.length > 0) {
      try {
        providerRegistry.registerDiscoveredProviders(result.servers);
        restoreRuntimeModel(
          providerRegistry,
          configManager.get('provider.model') as string,
          runtime,
        );
      } catch (err) {
        logger.warn('[bootstrap] Scan provider registration failed', {
          error: summarizeError(err),
        });
      }
    }

    for (const server of newServers) {
      systemMessageRouter.low(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''})`,
      );
    }

    if (result.servers.length > 0 && removedServers.length > 0) {
      removePersistedProviders({ ...shellPaths, surfaceRoot }, removedServers);
      for (const server of removedServers) {
        systemMessageRouter.low(
          `[Scan] ${server.name} at ${server.host}:${server.port} is no longer reachable — removed`,
        );
        const currentModelBareId = splitModelRegistryKey(currentModel).resolvedModelId;
        const wasActive = server.models.includes(currentModelBareId);
        if (wasActive) {
          configManager.set('provider.model', FALLBACK_MODEL.model);
          try {
            providerRegistry.setCurrentModel(FALLBACK_MODEL.model);
            runtime.model = FALLBACK_MODEL.model;
            runtime.provider = FALLBACK_MODEL.provider;
          } catch (err) {
            logger.warn('[bootstrap] Model switch after server removal failed', {
              error: summarizeError(err),
            });
          }
          systemMessageRouter.high(
            `[Scan] Active model was on ${server.name} — switched to ${FALLBACK_MODEL.model}`,
          );
        }
      }
    }

    if (result.servers.length > 0) {
      persistProviders({ ...shellPaths, surfaceRoot }, result.servers);
    }

    if (newServers.length > 0 || removedServers.length > 0) {
      requestRender();
    }
  }).catch((error: unknown) => {
    if (stopped) return;
    logger.warn('[bootstrap] Provider discovery scan failed', {
      error: summarizeError(error),
    });
  });
  return handle;
}

export interface BackgroundMcpDiscoveryOptions {
  mcpRegistry: McpRegistry;
  systemMessageRouter: HostSystemMessageSink;
  requestRender: () => void;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
  surfaceRoot: string;
}

/**
 * Schedules MCP auto-discovery and returns a handle that cancels the delayed
 * scan and suppresses late async side effects after host shutdown.
 */
export function scheduleBackgroundMcpDiscovery(options: BackgroundMcpDiscoveryOptions): BackgroundRuntimeTaskHandle {
  const { mcpRegistry, systemMessageRouter, requestRender, shellPaths, surfaceRoot } = options;
  let stopped = false;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  const handle: BackgroundRuntimeTaskHandle = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
    },
  };

  mcpRegistry.connectAll(shellPaths).catch((err) => {
    if (stopped) return;
    logger.warn('MCP auto-connect failed', { error: summarizeError(err) });
  });

  scanTimer = setTimeout(() => {
    scanTimer = null;
    if (stopped) return;
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers({ ...shellPaths, surfaceRoot }, registeredNames).then((result) => {
      if (stopped) return;
      if (result.suggestions.length === 0) return;
      for (const suggestion of result.suggestions) {
        systemMessageRouter.low(
          `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} ${(suggestion.args ?? []).join(' ')}). Add it to .goodvibes/mcp.json or ~/.config/mcp/mcp.json to enable it.`,
        );
      }
      requestRender();
    }).catch((err) => {
      if (stopped) return;
      logger.warn('MCP auto-discovery scan failed', { error: summarizeError(err) });
    });
  }, 2000);
  scanTimer.unref?.();
  return handle;
}
