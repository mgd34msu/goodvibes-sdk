/**
 * Tool LLM — internal LLM access for tool operations.
 *
 * Provides a lightweight interface for tool-internal LLM calls:
 * semantic diff, auto-heal, commit messages, prompt hooks, etc.
 *
 * Resolution order:
 *   1. tools.llmProvider + tools.llmModel from config
 *   2. Currently selected provider/model from providerRegistry
 *
 * Design constraints:
 *   - Disabled tool LLM resolves to null.
 *   - Configured routes are provider-qualified through the model registry.
 *   - ToolLLM.chat() throws request and configuration failures.
 */

import type { ConfigManager } from './manager.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Resolved provider + model pair for tool-internal LLM calls. */
export interface ResolvedToolLLM {
  provider: LLMProvider;
  modelId: string;
}

export interface ToolLLMDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
}

export class ToolLLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolLLMUnavailableError';
  }
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveConfiguredToolRoute(deps: ToolLLMDeps, providerId: string, modelId: string): ResolvedToolLLM {
  const registryKey = modelId.includes(':') ? modelId : `${providerId}:${modelId}`;
  const parsed = splitModelRegistryKey(registryKey);
  if (parsed.providerId !== providerId) {
    throw new Error(`Tool LLM model '${modelId}' conflicts with provider '${providerId}'.`);
  }
  return {
    provider: deps.providerRegistry.getForModel(registryKey, providerId),
    modelId: parsed.resolvedModelId,
  };
}

/**
 * Resolve the LLM provider and model to use for tool-internal operations.
 *
 * Resolution order:
 *   1. If tools.llmProvider + tools.llmModel are set in config, use that route.
 *   2. Otherwise use the currently selected provider/model.
 *
 * Returns null only when tools.llmEnabled is false.
 */
export function resolveToolLLM(deps: ToolLLMDeps): ResolvedToolLLM | null {
  try {
    const enabled = deps.configManager.get('tools.llmEnabled');
    if (!enabled) return null;

    const cfgProvider = readOptionalString(deps.configManager.get('tools.llmProvider'));
    const cfgModel = readOptionalString(deps.configManager.get('tools.llmModel'));

    if (cfgProvider || cfgModel) {
      if (!cfgProvider || !cfgModel) {
        throw new Error('Tool LLM routing requires both tools.llmProvider and tools.llmModel.');
      }
      return resolveConfiguredToolRoute(deps, cfgProvider, cfgModel);
    }

    // Main route: use the unambiguous current registry key, then send the
    // provider-local model id to the provider implementation.
    const currentDef = deps.providerRegistry.getCurrentModel();
    const provider = deps.providerRegistry.getForModel(currentDef.registryKey, currentDef.provider);
    return { provider, modelId: currentDef.id };
  } catch (err) {
    logger.error('resolveToolLLM: failed to resolve provider/model', { error: summarizeError(err) });
    throw err;
  }
}

/** Chat options for tool-internal LLM calls. */
export interface ToolLLMChatOptions {
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
}

/**
 * ToolLLM — lightweight LLM interface for internal tool operations.
 *
 * Usage:
 *   const result = await toolLLM.chat('Generate a commit message for: ...');
 *
 * Returns provider text. Throws when disabled, unresolved, or when the provider
 * request fails.
 */
export class ToolLLM {
  constructor(private readonly deps: ToolLLMDeps) {}

  /**
   * Send a single-turn prompt to the tool LLM.
   *
   * @param prompt   The user prompt to send.
   * @param options  Optional maxTokens and systemPrompt.
   * @returns        The assistant's text response.
   */
  async chat(prompt: string, options: ToolLLMChatOptions = {}): Promise<string> {
    try {
      const resolved = resolveToolLLM(this.deps);
      if (!resolved) {
        throw new ToolLLMUnavailableError('Tool LLM is disabled.');
      }

      const { provider, modelId } = resolved;
      const response = await provider.chat({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens ?? 1024,
        systemPrompt: options.systemPrompt,
      });

      if (typeof response.content !== 'string') {
        throw new Error('Tool LLM response did not include string content.');
      }
      return response.content;
    } catch (err) {
      logger.error('ToolLLM.chat: request failed', { error: summarizeError(err) });
      throw err;
    }
  }
}
