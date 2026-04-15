import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/scanner';
import type { LLMProvider } from './interface.js';
import { getDiscoveredTraits } from './discovered-traits.js';
import { LocalAIProvider, TGIProvider, VLLMProvider } from './discovered-compat.js';
import { LlamaCppProvider } from './llama-cpp.js';
import { LMStudioProvider } from './lm-studio.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { OllamaProvider } from './ollama.js';

export function createDiscoveredProvider(server: DiscoveredServer): LLMProvider {
  const traits = getDiscoveredTraits(server.serverType);
  const common = {
    name: server.name,
    baseURL: server.baseURL,
    apiKey: '',
    defaultModel: server.models[0]!,
    models: server.models,
    capabilities: traits.providerCapabilities,
  };

  switch (traits.adapter) {
    case 'lm-studio':
      return new LMStudioProvider(common);
    case 'ollama':
      return new OllamaProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'vllm':
      return new VLLMProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'llamacpp':
      return new LlamaCppProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'tgi':
      return new TGIProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    case 'localai':
      return new LocalAIProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
    default:
      return new OpenAICompatProvider({
        ...common,
        reasoningFormat: traits.reasoningFormat,
      });
  }
}

export function getDiscoveredReasoningFormat(
  serverType: DiscoveredServer['serverType'],
): 'llamacpp' | 'none' {
  return getDiscoveredTraits(serverType).reasoningFormat;
}
