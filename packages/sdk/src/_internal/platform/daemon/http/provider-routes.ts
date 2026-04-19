/**
 * provider-routes.ts
 *
 * HTTP route handlers for provider and model discovery/selection.
 *
 * Routes:
 *   GET    /api/providers          — list all providers + models with configured flags
 *   GET    /api/providers/current  — return current model + configured status
 *   PATCH  /api/providers/current  — switch current model live
 *
 * All routes require the existing daemon bearer-token auth (enforced by the
 * caller — DaemonHttpRouter.handleRequest validates auth before dispatching).
 */

import type { ProviderRegistry } from '../../providers/registry.js';
import type { ConfigManager } from '../../config/manager.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { SecretsManager } from '../../config/secrets.js';
import { findModelDefinition } from '../../providers/registry-models.js';
import { BUILTIN_COMPAT_PROVIDERS, BUILTIN_PROVIDER_ENV_KEYS } from '../../providers/builtin-catalog.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Provider label map — brand-accurate display names
// ---------------------------------------------------------------------------

const BUILTIN_LABEL_MAP: Record<string, string> = {
  // Native / first-party providers (not in BUILTIN_COMPAT_PROVIDERS)
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  inceptionlabs: 'Inception Labs',
  'amazon-bedrock': 'Amazon Bedrock',
  'amazon-bedrock-mantle': 'Amazon Bedrock (Mantle)',
  'anthropic-vertex': 'Anthropic (Vertex)',
  'github-copilot': 'GitHub Copilot',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  'ollama-cloud': 'Ollama Cloud',
  huggingface: 'Hugging Face',
  nvidia: 'NVIDIA',
  llm7: 'LLM7',
  perplexity: 'Perplexity',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  microsoft: 'Microsoft',
  vydra: 'Vydra',
  byteplus: 'BytePlus',
  fal: 'fal.ai',
  comfy: 'ComfyUI',
  runway: 'Runway',
  alibaba: 'Alibaba Cloud',
  synthetic: 'Synthetic (Local)',
};

// Build label map from the compat catalog (these already carry a label field)
const _catalogLabelMap: Record<string, string> = {};
for (const def of BUILTIN_COMPAT_PROVIDERS) {
  if (def.label) _catalogLabelMap[def.id] = def.label;
}

function getProviderLabel(providerId: string): string {
  return (
    BUILTIN_LABEL_MAP[providerId] ??
    _catalogLabelMap[providerId] ??
    providerId.charAt(0).toUpperCase() + providerId.slice(1)
  );
}

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

export interface ProviderModelRef {
  readonly registryKey: string;
  readonly provider: string;
  readonly id: string;
}

export interface ProviderModelEntry {
  readonly id: string;
  readonly registryKey: string;
  readonly provider: string;
  readonly label?: string;
  readonly contextWindow?: number;
}

export type ConfiguredVia = 'env' | 'secrets' | 'subscription' | 'anonymous';

export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia;
  readonly envVars: string[];
  readonly models: ProviderModelEntry[];
}

export interface ListProvidersResponse {
  readonly providers: ProviderEntry[];
  readonly currentModel: ProviderModelRef | null;
}

export interface CurrentModelResponse {
  readonly model: ProviderModelRef | null;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia;
}

export interface PatchCurrentModelResponse extends CurrentModelResponse {
  readonly persisted: boolean;
}

// ---------------------------------------------------------------------------
// Route context
// ---------------------------------------------------------------------------

export interface ProviderRouteContext {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly secretsManager?: Pick<SecretsManager, 'get'> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pre-resolve all non-env secret keys stored in SecretsManager in one async
 * batch. The resulting set is passed into the synchronous getConfiguredVia so
 * that the secrets tier check remains pure/non-async.
 */
async function resolveSecretKeys(
  secretsManager?: Pick<SecretsManager, 'get'> | null,
): Promise<ReadonlySet<string>> {
  if (!secretsManager) return new Set<string>();
  // Enumerate all env var names that any known provider might use
  const allEnvVarNames = Object.values(BUILTIN_PROVIDER_ENV_KEYS).flat() as string[];
  const results = await Promise.all(
    allEnvVarNames.map(async (v) => {
      if (typeof process.env[v] === 'string' && (process.env[v] as string).length > 0) {
        // Already in env; skip the secrets lookup to avoid redundant I/O
        return null;
      }
      const val = await secretsManager.get(v);
      return val !== null ? v : null;
    }),
  );
  return new Set(results.filter((v): v is string => v !== null));
}

function getConfiguredVia(
  providerId: string,
  envVars: string[],
  providerRegistry: ProviderRegistry,
  secretKeys?: ReadonlySet<string>,
): ConfiguredVia | undefined {
  // Tier 1: env var present
  const hasEnvKey = envVars.some((v) => {
    const val = process.env[v];
    return typeof val === 'string' && val.length > 0;
  });
  if (hasEnvKey) return 'env';

  // Tier 2: SecretsManager has a stored value for any of the provider's env var names
  if (secretKeys && envVars.some((v) => secretKeys.has(v))) return 'secrets';

  // Tier 3: detect anonymous providers (no env vars required by design)
  const catalogDef = BUILTIN_COMPAT_PROVIDERS.find((d) => d.id === providerId);
  if (catalogDef?.allowAnonymous && catalogDef?.anonymousConfigured) return 'anonymous';

  // Tier 4: present in configuredProviderIds but not env — subscription-backed
  const configuredIds = providerRegistry.getConfiguredProviderIds();
  if (configuredIds.includes(providerId)) return 'subscription';

  return undefined;
}

function buildCurrentModelResponse(
  providerRegistry: ProviderRegistry,
  secretKeys?: ReadonlySet<string>,
): CurrentModelResponse {
  let model: ProviderModelRef | null = null;
  let configured = false;
  let configuredVia: ConfiguredVia | undefined;

  try {
    const current = providerRegistry.getCurrentModel();
    const registryKey = current.registryKey ?? `${current.provider}:${current.id}`;
    model = { registryKey, provider: current.provider, id: current.id };

    // Determine configured status for the current model's provider
    const envVars = (BUILTIN_PROVIDER_ENV_KEYS[current.provider] ?? []) as string[];
    const via = getConfiguredVia(current.provider, envVars, providerRegistry, secretKeys);
    if (via !== undefined) {
      configured = true;
      configuredVia = via;
    }
  } catch {
    // No model configured
  }

  return { model, configured, configuredVia };
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

export async function dispatchProviderRoutes(
  req: Request,
  context: ProviderRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/api/providers' && req.method === 'GET') {
    return handleListProviders(context);
  }

  if (pathname === '/api/providers/current' && req.method === 'GET') {
    return handleGetCurrentModel(context);
  }

  if (pathname === '/api/providers/current' && req.method === 'PATCH') {
    return handlePatchCurrentModel(req, context);
  }

  return null;
}

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------

async function handleListProviders(context: ProviderRouteContext): Promise<Response> {
  const { providerRegistry, secretsManager } = context;

  // Pre-resolve which secret keys are stored (one async batch, then sync logic below)
  const secretKeys = await resolveSecretKeys(secretsManager);

  const allModels = providerRegistry.listModels();
  const configuredIds = new Set(providerRegistry.getConfiguredProviderIds());

  // Group models by provider
  const byProvider = new Map<string, ProviderModelEntry[]>();
  for (const model of allModels) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    const registryKey = model.registryKey ?? `${model.provider}:${model.id}`;
    byProvider.get(model.provider)!.push({
      id: model.id,
      registryKey,
      provider: model.provider,
      label: model.displayName ?? model.id,
      contextWindow: model.contextWindow > 0 ? model.contextWindow : undefined,
    });
  }

  const providers: ProviderEntry[] = [];
  for (const [providerId, models] of byProvider) {
    const envVars = (BUILTIN_PROVIDER_ENV_KEYS[providerId] ?? []) as string[];
    const via = getConfiguredVia(providerId, envVars, providerRegistry, secretKeys);
    const configured = via !== undefined;
    const configuredVia = configured ? via : undefined;

    const label = getProviderLabel(providerId);

    providers.push({ id: providerId, label, configured, configuredVia, envVars, models });
  }

  // Sort: configured first, then alphabetical
  providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const currentModel = buildCurrentModelResponse(providerRegistry, secretKeys).model;

  const body: ListProvidersResponse = { providers, currentModel };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// GET /api/providers/current
// ---------------------------------------------------------------------------

async function handleGetCurrentModel(context: ProviderRouteContext): Promise<Response> {
  const secretKeys = await resolveSecretKeys(context.secretsManager);
  return Response.json(buildCurrentModelResponse(context.providerRegistry, secretKeys));
}

// ---------------------------------------------------------------------------
// PATCH /api/providers/current
// ---------------------------------------------------------------------------

async function handlePatchCurrentModel(
  req: Request,
  context: ProviderRouteContext,
): Promise<Response> {
  const { providerRegistry, configManager } = context;

  const bodyOrErr = await context.parseJsonBody(req);
  if (bodyOrErr instanceof Response) return bodyOrErr;

  const body = bodyOrErr as Record<string, unknown>;
  const registryKey = typeof body['registryKey'] === 'string' ? body['registryKey'] : null;

  if (!registryKey) {
    return Response.json(
      { error: 'Missing required field: registryKey', code: 'INVALID_REQUEST' },
      { status: 400 },
    );
  }

  // Validate the model exists
  const allModels = providerRegistry.listModels();
  const modelDef = findModelDefinition(registryKey, allModels);
  if (!modelDef) {
    return Response.json(
      { error: `Model '${registryKey}' not in registry`, code: 'MODEL_NOT_FOUND' },
      { status: 400 },
    );
  }

  // Check provider is configured
  const configuredIds = new Set(providerRegistry.getConfiguredProviderIds());
  if (!configuredIds.has(modelDef.provider)) {
    const envVars = (BUILTIN_PROVIDER_ENV_KEYS[modelDef.provider] ?? []) as string[];
    const errorMessage = envVars.length > 0
      ? `Provider '${modelDef.provider}' not configured: set one of [${envVars.join(', ')}]`
      : `Provider '${modelDef.provider}' is not configured. Check the provider's configuration (env var, subscription, or network discovery).`;
    return Response.json(
      {
        error: errorMessage,
        code: 'PROVIDER_NOT_CONFIGURED',
        missingEnvVars: envVars,
      },
      { status: 409 },
    );
  }

  // Switch the model — setCurrentModel now emits the event internally
  try {
    providerRegistry.setCurrentModel(registryKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, code: 'SET_MODEL_FAILED' }, { status: 400 });
  }

  // Persist to config
  let persisted = false;
  try {
    configManager.set('provider.model', modelDef.id);
    configManager.set('provider.provider', modelDef.provider);
    persisted = true;
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    logger.warn(`[provider-routes] Failed to persist model selection to config: ${msg}`);
  }

  // setCurrentModel emits MODEL_CHANGED synchronously on the same runtimeBus —
  // no second emission needed here.
  const secretKeys = await resolveSecretKeys(context.secretsManager);
  return Response.json({ ...buildCurrentModelResponse(providerRegistry, secretKeys), persisted });
}
