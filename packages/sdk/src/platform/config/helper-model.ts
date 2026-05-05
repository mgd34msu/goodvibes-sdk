/**
 * Helper Model — lightweight LLM routing for grunt-work tasks.
 *
 * Routes tasks like cache planning, compaction, commit messages, etc. to a
 * cheaper/free model so expensive main models don't waste tokens on routine work.
 *
 * Resolution order:
 *   1. Per-provider helper (helper.providers.{currentProvider}.provider + model)
 *   2. Global helper (helper.globalProvider + helper.globalModel)
 *   3. Tool LLM (tools.llmProvider + tools.llmModel) — when enabled/configured
 *
 * Design constraints:
 *   - Optional helper absence is explicit: helperOnly calls return null.
 *   - Configured routes are provider-qualified through the model registry.
 *   - HelperModel.chat() throws request and configuration failures.
 *   - Tracks token usage separately from the main model
 */

import type { ConfigManager } from './manager.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { splitModelRegistryKey } from '../providers/registry-helpers.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Tasks that can be routed to a helper model. */
export type HelperTask =
  | 'cache_strategy'     // Plan cache breakpoints + TTL
  | 'compaction'         // Summarize prior context for compaction
  | 'intent_classify'    // Classify user intent (question vs task)
  | 'tool_summarize'     // Condense large tool output
  | 'commit_message'     // Generate commit messages
  | 'review_triage';     // Triage which files need deep review

/** Resolved helper model: provider instance + model ID. */
export interface ResolvedHelper {
  provider: LLMProvider;
  modelId: string;
  /** true when a dedicated helper/tool-LLM route was configured. */
  isHelper: boolean;
}

/** Options for helper model invocation. */
export interface HelperChatOptions {
  maxTokens?: number | undefined;
  systemPrompt?: string | undefined;
  /** If true, return null when no dedicated helper route is available. */
  helperOnly?: boolean | undefined;
}

/** Token usage tracking for helper model calls. */
export interface HelperUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface HelperModelDeps {
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
}

export class HelperModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperModelUnavailableError';
  }
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * HelperRouter — resolves which model to use for a given helper task.
 *
 * Resolution order:
 *   1. Per-provider helper (helper.providers.{currentProvider}.provider + model)
 *   2. Global helper (helper.globalProvider + helper.globalModel)
 *   3. Tool LLM (tools.llmProvider + tools.llmModel) — when enabled/configured
 */
export class HelperRouter {
  constructor(private readonly deps: HelperModelDeps) {}

  private resolveConfiguredProviderModel(providerId: string, modelId: string): ResolvedHelper {
    const provider = providerId.trim();
    const model = modelId.trim();
    if (!provider || !model) {
      throw new Error('Helper model route requires provider and model.');
    }
    const registryKey = model.includes(':') ? model : `${provider}:${model}`;
    const parsed = splitModelRegistryKey(registryKey);
    if (parsed.providerId !== provider) {
      throw new Error(`Helper model '${model}' conflicts with provider '${provider}'.`);
    }
    return {
      provider: this.deps.providerRegistry.getForModel(registryKey, provider),
      modelId: parsed.resolvedModelId,
      isHelper: true,
    };
  }

  /**
   * Resolve the best helper for the given task.
   *
   * Returns null only when no dedicated helper route is configured.
   */
  resolve(_task: HelperTask): ResolvedHelper | null {
    try {
      // 1. Check per-provider helper
      const currentModel = this.deps.providerRegistry.getCurrentModel();
      const currentProviderName = currentModel.provider ?? '';

      // Per-provider helpers stored in config as helper.providers.{name}.provider and .model
      // These are accessed via getCategory since they're nested objects
      const helperConfig = this.deps.configManager.getCategory('helper') as Record<string, unknown> | undefined;
      if (helperConfig) {
        const providers = helperConfig['providers'] as Record<string, { provider?: string; model?: string }> | undefined;
        if (providers && currentProviderName && providers[currentProviderName]) {
          const perProvider = providers[currentProviderName]!;
          const provider = readOptionalString(perProvider.provider);
          const model = readOptionalString(perProvider.model);
          if (provider || model) {
            if (!provider || !model) {
              throw new Error(`Per-provider helper route for '${currentProviderName}' requires provider and model.`);
            }
            return this.resolveConfiguredProviderModel(provider, model);
          }
        }
      }

      // 2. Global helper
      const globalProvider = readOptionalString(this.deps.configManager.get('helper.globalProvider'));
      const globalModel = readOptionalString(this.deps.configManager.get('helper.globalModel'));
      if (globalProvider || globalModel) {
        if (!globalProvider || !globalModel) {
          throw new Error('Global helper routing requires both helper.globalProvider and helper.globalModel.');
        }
        return this.resolveConfiguredProviderModel(globalProvider, globalModel);
      }

      // 3. Tool LLM
      const toolEnabled = this.deps.configManager.get('tools.llmEnabled') as boolean;
      const toolProvider = readOptionalString(this.deps.configManager.get('tools.llmProvider'));
      const toolModel = readOptionalString(this.deps.configManager.get('tools.llmModel'));
      if (toolEnabled && (toolProvider || toolModel)) {
        if (!toolProvider || !toolModel) {
          throw new Error('Helper tool-LLM routing requires both tools.llmProvider and tools.llmModel.');
        }
        return this.resolveConfiguredProviderModel(toolProvider, toolModel);
      }

      return null;
    } catch (err) {
      logger.error('HelperRouter.resolve: failed', { task: _task, error: summarizeError(err) });
      throw err;
    }
  }
}

/**
 * HelperModel — lightweight LLM interface for helper tasks.
 *
 * Callers own HelperModel lifetimes explicitly. Provider and configuration
 * failures throw. Explicit optional-helper calls return null when unavailable.
 * Tracks token usage separately from the main model.
 */
export class HelperModel {
  private readonly router: HelperRouter;
  private _usage: HelperUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(private readonly deps: HelperModelDeps) {
    this.router = new HelperRouter(deps);
  }

  /**
   * Send a prompt to the helper model for the given task.
   *
   * @param task     The helper task type (for routing).
   * @param prompt   The user prompt to send.
   * @param options  Optional maxTokens, systemPrompt, helperOnly.
   * @returns        The assistant's text response, or null for explicit optional helper absence.
   */
  async chat(task: HelperTask, prompt: string, options: HelperChatOptions = {}): Promise<string | null> {
    const enabled = this.deps.configManager.get('helper.enabled') as boolean;
    if (!enabled) {
      if (options.helperOnly) {
        logger.info('HelperModel.chat: helper disabled for optional helper request', { task });
        return null;
      }
      throw new HelperModelUnavailableError('Helper model routing is disabled.');
    }

    try {
      const resolved = this.router.resolve(task);
      if (!resolved) {
        if (options.helperOnly) {
          logger.info('HelperModel.chat: no helper route for optional helper request', { task });
          return null;
        }
        throw new HelperModelUnavailableError('No helper model route is configured.');
      }

      const response = await resolved.provider.chat({
        model: resolved.modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens ?? 2048,
        systemPrompt: options.systemPrompt,
      });

      // Track usage
      this._usage.inputTokens += response.usage?.inputTokens ?? 0;
      this._usage.outputTokens += response.usage?.outputTokens ?? 0;
      this._usage.calls += 1;

      logger.debug('HelperModel.chat: success', {
        task,
        isHelper: resolved.isHelper,
        modelId: resolved.modelId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });

      if (typeof response.content !== 'string') {
        throw new Error('Helper model response did not include string content.');
      }
      return response.content;
    } catch (err) {
      logger.error('HelperModel.chat: request failed', { task, error: summarizeError(err) });
      throw err;
    }
  }

  /** Get cumulative helper usage since last reset. */
  getUsage(): Readonly<HelperUsage> {
    return { ...this._usage };
  }

  /** Reset usage counters. */
  resetUsage(): void {
    this._usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  }
}
