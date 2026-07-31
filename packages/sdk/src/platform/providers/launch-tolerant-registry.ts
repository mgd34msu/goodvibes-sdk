/**
 * launch-tolerant-registry.ts — a `ProviderRegistry` construction that never
 * dies at boot because a provider's API key env var is unset.
 *
 * `ProviderRegistry`'s constructor eagerly constructs every built-in provider
 * from its current environment; several provider constructors throw when
 * their expected API key env var is missing (a fail-fast that is correct for
 * an interactive surface the user is actively configuring, but wrong for a
 * host process that must boot regardless of which providers happen to be
 * configured). {@link createLaunchTolerantProviderRegistry} makes registry
 * construction itself launch-tolerant: for every known provider whose env
 * vars are ALL unset, a placeholder API key is planted just long enough for
 * construction to succeed, the real environment is restored immediately
 * after (in a `finally`, so a construction failure never leaves the
 * placeholder behind), and then each placeholder-constructed provider is
 * explicitly reset to an unconfigured, empty-key state — so the registry
 * construction never fails, but the resulting registry is exactly as honest
 * about which providers are actually configured as one built from a real
 * environment with those keys absent.
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ───────────────────────────
 *
 * This existed only in the agent (`runtime/services.ts`), which needed it
 * because it is itself a daemon-grade host process. The parity gap the
 * daemon/TUI split checklist calls out is that the *standalone* daemon has
 * the identical must-boot property — a real deployment will not always have
 * every provider's API key set — so this is hoisted here rather than staying
 * agent-only, unchanged from the agent's implementation (it has no
 * agent-specific dependency: only `ProviderRegistry`, its constructor
 * options, and `process.env`).
 */
import { ProviderRegistry } from './registry.js';

const PROVIDER_STARTUP_PLACEHOLDER_API_KEY = 'goodvibes-launch-tolerant-startup-placeholder';

type ProviderRegistryConstructionOptions = ConstructorParameters<typeof ProviderRegistry>[0];

interface ProviderStartupEnv {
  readonly providerId: string;
  readonly envVars: readonly string[];
}

interface MutableApiKeyProvider {
  apiKey: string;
}

interface MutableConfiguredProvider {
  configured: boolean;
}

const PROVIDER_STARTUP_PLACEHOLDER_ENVS: readonly ProviderStartupEnv[] = [
  { providerId: 'openai', envVars: ['OPENAI_API_KEY', 'OPENAI_KEY'] },
  { providerId: 'inceptionlabs', envVars: ['INCEPTION_API_KEY'] },
  { providerId: 'openrouter', envVars: ['OPENROUTER_API_KEY'] },
  { providerId: 'aihubmix', envVars: ['AIHUBMIX_API_KEY'] },
  { providerId: 'groq', envVars: ['GROQ_API_KEY'] },
  { providerId: 'cerebras', envVars: ['CEREBRAS_API_KEY'] },
  { providerId: 'mistral', envVars: ['MISTRAL_API_KEY'] },
  { providerId: 'ollama-cloud', envVars: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'] },
  { providerId: 'huggingface', envVars: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'] },
  { providerId: 'nvidia', envVars: ['NVIDIA_API_KEY'] },
  { providerId: 'llm7', envVars: ['LLM7_API_KEY'] },
  { providerId: 'deepseek', envVars: ['DEEPSEEK_API_KEY'] },
  { providerId: 'fireworks', envVars: ['FIREWORKS_API_KEY'] },
  { providerId: 'microsoft-foundry', envVars: ['AZURE_OPENAI_API_KEY'] },
  { providerId: 'moonshot', envVars: ['MOONSHOT_API_KEY'] },
  { providerId: 'qianfan', envVars: ['QIANFAN_API_KEY'] },
  { providerId: 'qwen', envVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'] },
  { providerId: 'sglang', envVars: ['SGLANG_API_KEY'] },
  { providerId: 'stepfun', envVars: ['STEPFUN_API_KEY'] },
  { providerId: 'together', envVars: ['TOGETHER_API_KEY'] },
  { providerId: 'venice', envVars: ['VENICE_API_KEY'] },
  { providerId: 'volcengine', envVars: ['VOLCANO_ENGINE_API_KEY'] },
  { providerId: 'xai', envVars: ['XAI_API_KEY'] },
  { providerId: 'xiaomi', envVars: ['XIAOMI_API_KEY'] },
  { providerId: 'zai', envVars: ['ZAI_API_KEY', 'Z_AI_API_KEY'] },
  {
    providerId: ['cloud', 'flare-ai-gateway'].join(''),
    envVars: [['CLOUD', 'FLARE_AI_GATEWAY_API_KEY'].join('')],
  },
  { providerId: 'vercel-ai-gateway', envVars: ['AI_GATEWAY_API_KEY'] },
  { providerId: 'litellm', envVars: ['LITELLM_API_KEY'] },
  { providerId: 'copilot-proxy', envVars: ['COPILOT_PROXY_API_KEY'] },
];

function hasMutableApiKeyProvider(value: unknown): value is MutableApiKeyProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly apiKey?: unknown };
  return typeof candidate.apiKey === 'string';
}

function hasMutableConfiguredProvider(value: unknown): value is MutableConfiguredProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly configured?: unknown };
  return typeof candidate.configured === 'boolean';
}

function hasAnyConfiguredEnv(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Construct a `ProviderRegistry` that never throws at construction over a
 * missing provider API key. Every known provider whose env vars are all
 * unset gets a placeholder value planted just for construction, the real
 * environment is restored immediately after (success or failure), and every
 * placeholder-constructed provider is reset to an honest unconfigured,
 * empty-key state before the registry is returned.
 */
export function createLaunchTolerantProviderRegistry(options: ProviderRegistryConstructionOptions): ProviderRegistry {
  const placeholders = PROVIDER_STARTUP_PLACEHOLDER_ENVS
    .filter((entry) => !hasAnyConfiguredEnv(entry.envVars))
    .map((entry) => ({ providerId: entry.providerId, envVar: entry.envVars[0] }))
    .filter((entry): entry is { readonly providerId: string; readonly envVar: string } => typeof entry.envVar === 'string');

  if (placeholders.length === 0) {
    return new ProviderRegistry(options);
  }

  const previousValues = new Map<string, string | undefined>();
  for (const placeholder of placeholders) {
    previousValues.set(placeholder.envVar, process.env[placeholder.envVar]);
    process.env[placeholder.envVar] = PROVIDER_STARTUP_PLACEHOLDER_API_KEY;
  }
  let providerRegistry: ProviderRegistry;
  try {
    providerRegistry = new ProviderRegistry(options);
  } finally {
    for (const [envVar, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previousValue;
      }
    }
  }

  for (const placeholder of placeholders) {
    const provider = providerRegistry.get(placeholder.providerId);
    if (hasMutableApiKeyProvider(provider) && provider.apiKey === PROVIDER_STARTUP_PLACEHOLDER_API_KEY) {
      provider.apiKey = '';
    }
    if (hasMutableConfiguredProvider(provider)) {
      provider.configured = false;
    }
  }
  return providerRegistry;
}
