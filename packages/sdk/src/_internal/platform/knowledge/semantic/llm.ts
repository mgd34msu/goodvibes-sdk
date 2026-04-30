import type { ProviderRegistry } from '../../providers/registry.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { KnowledgeSemanticLlm } from './types.js';
import { extractJsonObject } from './utils.js';

export function createProviderBackedKnowledgeSemanticLlm(
  providerRegistry: ProviderRegistry,
): KnowledgeSemanticLlm {
  return {
    completeJson: async (input) => {
      const text = await completeWithCurrentModel(providerRegistry, input);
      return text ? extractJsonObject(text) : null;
    },
    completeText: async (input) => completeWithCurrentModel(providerRegistry, input),
  };
}

async function completeWithCurrentModel(
  providerRegistry: ProviderRegistry,
  input: {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly maxTokens?: number;
    readonly purpose: string;
  },
): Promise<string | null> {
  try {
    const current = providerRegistry.getCurrentModel();
    const provider = providerRegistry.getForModel(current.id, current.provider);
    const response = await provider.chat({
      model: current.id,
      messages: [{ role: 'user', content: input.prompt }],
      systemPrompt: input.systemPrompt,
      maxTokens: input.maxTokens ?? 1800,
      reasoningEffort: 'low',
    });
    const content = response.content?.trim() ?? '';
    return content.length > 0 ? content : null;
  } catch (error) {
    logger.debug('Knowledge semantic LLM request failed', {
      purpose: input.purpose,
      error: summarizeError(error),
    });
    return null;
  }
}
