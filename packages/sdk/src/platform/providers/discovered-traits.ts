import type { ServerType } from '../discovery/scanner.js';
import type { ProviderCapability } from './capabilities.js';
import type { ReasoningEffortSpec } from './reasoning-effort.js';

/**
 * Locally-discovered servers expose the four levels their adapters already map
 * (`lm-studio.ts`, `ollama.ts`, `llama-cpp.ts`).
 *
 * Marked `declared` rather than `catalog` because it is our own table for these
 * backends, not live feed data — and rather than `family` because it must
 * outrank the vendor family table. A local `deepseek-r1:70b` shares its name
 * with DeepSeek's hosted API but not its levels: the hosted row offers only
 * `high` and `max`, neither of which the ollama adapter maps, while the four
 * levels here are exactly the ones it does.
 */
export const LOCAL_SERVER_EFFORT: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['instant', 'low', 'medium', 'high'],
  source: 'declared',
};

export interface DiscoveredServerTraits {
  readonly adapter:
    | 'lm-studio'
    | 'ollama'
    | 'vllm'
    | 'llamacpp'
    | 'tgi'
    | 'localai'
    | 'compat';
  readonly reasoningFormat: 'llamacpp' | 'none';
  readonly providerCapabilities?: Partial<ProviderCapability> | undefined;
  readonly modelCapabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  readonly reasoningEffort?: ReasoningEffortSpec | undefined;
}

const DEFAULT_MODEL_CAPABILITIES = {
  toolCalling: true,
  codeEditing: true,
  reasoning: false,
  multimodal: false,
} as const;

const HIGH_TIMEOUT_MS = 300_000;

export function getDiscoveredTraits(serverType: ServerType): DiscoveredServerTraits {
  switch (serverType) {
    case 'lm-studio':
      return {
        adapter: 'lm-studio',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: true,
          jsonMode: false,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: LOCAL_SERVER_EFFORT,
      };
    case 'ollama':
      return {
        adapter: 'ollama',
        reasoningFormat: 'llamacpp',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: LOCAL_SERVER_EFFORT,
      };
    case 'vllm':
      return {
        adapter: 'vllm',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    case 'llamacpp':
      return {
        adapter: 'llamacpp',
        reasoningFormat: 'llamacpp',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: LOCAL_SERVER_EFFORT,
      };
    case 'tgi':
      return {
        adapter: 'tgi',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    case 'localai':
      return {
        adapter: 'localai',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    default:
      return {
        adapter: 'compat',
        reasoningFormat: 'none',
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
  }
}
