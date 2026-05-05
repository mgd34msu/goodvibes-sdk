/**
 * model-routes.ts
 *
 * HTTP route handlers for model catalog discovery and global model selection.
 *
 * Routes:
 *   GET    /api/models          — list all providers + models with configured flags
 *   GET    /api/models/current  — return current model + configured status
 *   PATCH  /api/models/current  — switch current model live
 *
 * All routes require the existing daemon bearer-token auth (enforced by the
 * caller — DaemonHttpRouter.handleRequest validates auth before dispatching).
 */

import type { ProviderRegistry } from '../../providers/registry.js';
import type { ConfigManager } from '../../config/manager.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ProviderAuthRouteDescriptor, ProviderRuntimeMetadata } from '../../providers/interface.js';
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

// Build label map from the built-in provider catalog.
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
  readonly label?: string | undefined;
  readonly contextWindow?: number | undefined;
}

export type ConfiguredVia = 'env' | 'secrets' | 'subscription' | 'anonymous';

export interface ModelRouteProviderRecord {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly envVars: string[];
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
  readonly models: ProviderModelEntry[];
}

export interface ListProviderModelsResponse {
  readonly providers: ModelRouteProviderRecord[];
  readonly currentModel: ProviderModelRef | null;
  /**
   * `true` when the secrets manager was unavailable for this response.
   * `false` when secrets resolution was attempted.
   */
  readonly secretsResolutionSkipped: boolean;
}

export interface CurrentModelResponse {
  readonly model: ProviderModelRef | null;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
}

export interface PatchCurrentModelResponse extends CurrentModelResponse {
  readonly persisted: boolean;
}

// ---------------------------------------------------------------------------
// Route context
// ---------------------------------------------------------------------------

export interface ModelRouteContext {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly secretsManager?: Pick<SecretsManager, 'get'> | null | undefined;
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

function getConfiguredViaFromLocalSignals(
  providerId: string,
  envVars: string[],
  secretKeys?: ReadonlySet<string>,
): ConfiguredVia | undefined {
  // Tier 1: env var present
  const hasEnvKey = envVars.some((v) => {
    const val = process.env[v]!;
    return typeof val === 'string' && val.length > 0;
  });
  if (hasEnvKey) return 'env';

  // Tier 2: SecretsManager has a stored value for any of the provider's env var names
  if (secretKeys && envVars.some((v) => secretKeys.has(v))) return 'secrets';

  // Tier 3: detect anonymous providers (no env vars required by design)
  const catalogDef = BUILTIN_COMPAT_PROVIDERS.find((d) => d.id === providerId);
  if (catalogDef?.allowAnonymous && catalogDef?.anonymousConfigured) return 'anonymous';

  return undefined;
}

function getConfiguredViaFromRegistry(providerId: string, providerRegistry: ProviderRegistry): ConfiguredVia | undefined {
  return providerRegistry.getConfiguredProviderIds().includes(providerId) ? 'subscription' : undefined;
}

function isRuntimeRouteUsable(route: ProviderAuthRouteDescriptor): boolean {
  return (
    route.configured &&
    route.usable !== false &&
    route.freshness !== 'expired' &&
    route.freshness !== 'pending' &&
    route.freshness !== 'unconfigured'
  );
}

function getConfiguredViaFromRuntimeRoutes(
  routes: readonly ProviderAuthRouteDescriptor[],
): ConfiguredVia | undefined {
  const usableRoutes = routes.filter(isRuntimeRouteUsable);
  if (usableRoutes.some((route) => route.route === 'subscription-oauth')) return 'subscription';
  if (usableRoutes.some((route) => route.route === 'secret-ref')) return 'secrets';
  const apiKeyRoute = usableRoutes.find((route) => route.route === 'api-key');
  if (apiKeyRoute) {
    const hasEnv = (apiKeyRoute.envVars ?? []).some((envVar) => {
      const value = process.env[envVar]!;
      return typeof value === 'string' && value.length > 0;
    });
    return hasEnv ? 'env' : 'secrets';
  }
  if (usableRoutes.some((route) => route.route === 'anonymous')) return 'anonymous';
  return undefined;
}

interface RuntimeAuthRouteLookup {
  readonly routes: readonly ProviderAuthRouteDescriptor[];
  readonly metadataAvailable: boolean;
  readonly metadataFailed: boolean;
}

async function describeAuthRoutes(
  providerRegistry: ProviderRegistry,
  providerId: string,
): Promise<RuntimeAuthRouteLookup> {
  const maybeRegistry = providerRegistry as unknown as {
    describeRuntime?: ((name: string) => Promise<ProviderRuntimeMetadata | null>) | undefined;
  };
  if (typeof maybeRegistry.describeRuntime !== 'function') {
    return { routes: [], metadataAvailable: false, metadataFailed: false };
  }

  try {
    const metadata = await maybeRegistry.describeRuntime(providerId);
    return {
      routes: metadata?.auth?.routes ?? [],
      metadataAvailable: metadata !== null,
      metadataFailed: false,
    };
  } catch (err: unknown) {
    logger.warn('[model-routes] Failed to read provider runtime metadata', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { routes: [], metadataAvailable: false, metadataFailed: true };
  }
}

interface ProviderConfiguredStatus {
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
}

async function resolveProviderConfiguredStatus(
  providerId: string,
  envVars: string[],
  providerRegistry: ProviderRegistry,
  secretKeys?: ReadonlySet<string>,
): Promise<ProviderConfiguredStatus> {
  const runtime = await describeAuthRoutes(providerRegistry, providerId);
  const { routes } = runtime;
  const runtimeVia = getConfiguredViaFromRuntimeRoutes(routes);
  const configuredViaFromLocalSignals = getConfiguredViaFromLocalSignals(providerId, envVars, secretKeys);
  const registryVia = !runtime.metadataAvailable && !runtime.metadataFailed
    ? getConfiguredViaFromRegistry(providerId, providerRegistry)
    : undefined;
  const hasUsableRuntimeRoute = routes.some((route) => isRuntimeRouteUsable(route) && route.route !== 'none');
  const configuredVia = runtimeVia ?? configuredViaFromLocalSignals ?? registryVia;
  return {
    configured: configuredVia !== undefined || hasUsableRuntimeRoute,
    configuredVia,
    ...(routes.length > 0 ? { routes } : {}),
  };
}

async function buildCurrentModelResponse(
  providerRegistry: ProviderRegistry,
  secretKeys?: ReadonlySet<string>,
): Promise<CurrentModelResponse> {
  let model: ProviderModelRef | null = null;
  let configured = false;
  let configuredVia: ConfiguredVia | undefined;
  let routes: readonly ProviderAuthRouteDescriptor[] | undefined;

  try {
    const current = providerRegistry.getCurrentModel();
    model = { registryKey: current.registryKey, provider: current.provider, id: current.id };

    // Determine configured status for the current model's provider
    const envVars = (BUILTIN_PROVIDER_ENV_KEYS[current.provider] ?? []) as string[];
    const status = await resolveProviderConfiguredStatus(current.provider, envVars, providerRegistry, secretKeys);
    configured = status.configured;
    configuredVia = status.configuredVia;
    routes = status.routes;
  } catch {
    // No model configured
  }

  return { model, configured, configuredVia, ...(routes ? { routes } : {}) };
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

export async function dispatchModelRoutes(
  req: Request,
  context: ModelRouteContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/api/models' && req.method === 'GET') {
    return handleListProviderModels(context);
  }

  if (pathname === '/api/models/current' && req.method === 'GET') {
    return handleGetCurrentModel(context);
  }

  if (pathname === '/api/models/current' && req.method === 'PATCH') {
    return handlePatchCurrentModel(req, context);
  }

  return null;
}

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------

async function handleListProviderModels(context: ModelRouteContext): Promise<Response> {
  const { providerRegistry, secretsManager } = context;

  // Pre-resolve which secret keys are stored (one async batch, then sync logic below)
  const secretKeys = await resolveSecretKeys(secretsManager);

  const allModels = providerRegistry.listModels();
  // Group models by provider
  const byProvider = new Map<string, ProviderModelEntry[]>();
  for (const model of allModels) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    byProvider.get(model.provider)?.push({
      id: model.id,
      registryKey: model.registryKey,
      provider: model.provider,
      label: model.displayName ?? model.id,
      contextWindow: model.contextWindow > 0 ? model.contextWindow : undefined,
    });
  }

  const providers: ModelRouteProviderRecord[] = [];
  for (const [providerId, models] of byProvider) {
    const envVars = (BUILTIN_PROVIDER_ENV_KEYS[providerId] ?? []) as string[];
    const status = await resolveProviderConfiguredStatus(providerId, envVars, providerRegistry, secretKeys);

    const label = getProviderLabel(providerId);

    providers.push({
      id: providerId,
      label,
      configured: status.configured,
      configuredVia: status.configuredVia,
      envVars,
      ...(status.routes ? { routes: status.routes } : {}),
      models,
    });
  }

  // Sort: configured first, then alphabetical
  providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const currentModel = (await buildCurrentModelResponse(providerRegistry, secretKeys)).model;

  const body: ListProviderModelsResponse = {
    providers,
    currentModel,
    secretsResolutionSkipped: !secretsManager,
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// GET /api/models/current
// ---------------------------------------------------------------------------

async function handleGetCurrentModel(context: ModelRouteContext): Promise<Response> {
  const secretKeys = await resolveSecretKeys(context.secretsManager);
  return Response.json(await buildCurrentModelResponse(context.providerRegistry, secretKeys));
}

// ---------------------------------------------------------------------------
// PATCH /api/models/current
// ---------------------------------------------------------------------------

async function handlePatchCurrentModel(
  req: Request,
  context: ModelRouteContext,
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
  if (!registryKey.includes(':')) {
    return Response.json(
      {
        error: `Model selection requires a provider-qualified registryKey; received '${registryKey}'`,
        code: 'INVALID_REQUEST',
      },
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

  // Check provider is configured. Runtime auth routes cover subscription-backed
  // providers like OpenAI, where the public model remains `openai:*` but the
  // actual turn path aliases to the subscription-backed provider at runtime.
  const envVars = (BUILTIN_PROVIDER_ENV_KEYS[modelDef.provider] ?? []) as string[];
  const secretKeys = await resolveSecretKeys(context.secretsManager);
  const configuredStatus = await resolveProviderConfiguredStatus(
    modelDef.provider,
    envVars,
    providerRegistry,
    secretKeys,
  );
  if (!configuredStatus.configured) {
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

  try {
    providerRegistry.setCurrentModel(registryKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message, code: 'SET_MODEL_FAILED' }, { status: 400 });
  }

  // Persist to config
  let persisted = false;
  try {
    configManager.set('provider.model', modelDef.registryKey);
    persisted = true;
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    logger.warn(`[model-routes] Failed to persist model selection to config: ${msg}`);
  }

  // setCurrentModel emits MODEL_CHANGED synchronously on the same runtimeBus —
  // no second emission needed here.
  return Response.json({ ...(await buildCurrentModelResponse(providerRegistry, secretKeys)), persisted });
}
