import type { ProviderRegistry } from '../../providers/registry.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { KnowledgeSemanticLlm } from './types.js';
import { extractJsonObject } from './utils.js';

export interface ProviderBackedKnowledgeSemanticLlmOptions {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

export function createProviderBackedKnowledgeSemanticLlm(
  providerRegistry: ProviderRegistry,
  options: ProviderBackedKnowledgeSemanticLlmOptions = {},
): KnowledgeSemanticLlm {
  const limiter = new SemanticLlmLimiter(Math.max(1, options.maxConcurrent ?? 1));
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);
  return {
    completeJson: async (input) => limiter.run(async () => {
      const text = await completeWithCurrentModel(providerRegistry, { ...input, timeoutMs: input.timeoutMs ?? timeoutMs });
      return text ? extractJsonObject(text) : null;
    }),
    completeText: async (input) => limiter.run(async () => completeWithCurrentModel(
      providerRegistry,
      { ...input, timeoutMs: input.timeoutMs ?? timeoutMs },
    )),
  };
}

async function completeWithCurrentModel(
  providerRegistry: ProviderRegistry,
  input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly purpose: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<string | null> {
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 20_000);
  const controller = new AbortController();
  const timeoutSentinel = Symbol('semantic-timeout');
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = (): void => controller.abort();
  if (input.signal?.aborted) return null;
  input.signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const current = providerRegistry.getCurrentModel();
    const provider = providerRegistry.getForModel(current.id, current.provider);
    const chatPromise = provider.chat({
      model: current.id,
      messages: [{ role: 'user', content: input.prompt }],
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens ?? 1800,
      reasoningEffort: 'low',
      signal: controller.signal,
    }).catch((error) => {
      if (timedOut || controller.signal.aborted) return null;
      throw error;
    });
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(timeoutSentinel);
      }, timeoutMs);
      timer.unref?.();
    });
    const response = await Promise.race([chatPromise, timeoutPromise]);
    if (response === timeoutSentinel) {
      logger.debug('Knowledge semantic LLM request timed out', {
        purpose: input.purpose,
        timeoutMs,
      });
      return null;
    }
    if (!response) return null;
    const content = response.content?.trim() ?? '';
    return content.length > 0 ? content : null;
  } catch (error) {
    logger.debug('Knowledge semantic LLM request failed', {
      purpose: input.purpose,
      error: summarizeError(error),
    });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

class SemanticLlmLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}
