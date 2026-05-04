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
  readonly label?: string | undefined;
  readonly contextWindow?: number | undefined;
}

export type ConfiguredVia = 'env' | 'secrets' | 'subscription' | 'anonymous';

export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly envVars: string[];
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
  readonly models: ProviderModelEntry[];
}

export interface ListProvidersResponse {
  readonly providers: ProviderEntry[];
  readonly currentModel: ProviderModelRef | null;
  /**
   * F-PROV-009: **always present** in responses from SDK 0.21.36 onwards.
   * `true` when the secretsManager was absent — secrets-tier providers will show
   * `configured:false` because the secrets layer was not consulted to resolve their
   * env-var-equivalent keys.
   * `false` when a secretsManager was provided (regardless of whether any keys were
   * actually resolved — see `configuredVia` on individual providers for that signal).
   *
   * Prior to 0.21.36 the field was emitted only when `true`, which made it
   * indistinguishable from "field was never introduced" for consumers that only
   * checked `'secretsResolutionSkipped' in response`. Always emitting the boolean
   * unambiguously answers "did the daemon attempt secrets resolution for this response".
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

export interface ProviderRouteContext {
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

function getConfiguredVia(
  providerId: string,
  envVars: string[],
  providerRegistry: ProviderRegistry,
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

  // Tier 4: present in configuredProviderIds but not env — subscription-backed
  const configuredIds = providerRegistry.getConfiguredProviderIds();
  if (configuredIds.includes(providerId)) return 'subscription';

  return undefined;
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

async function describeAuthRoutes(
  providerRegistry: ProviderRegistry,
  providerId: string,
): Promise<readonly ProviderAuthRouteDescriptor[]> {
  const maybeRegistry = providerRegistry as unknown as {
    describeRuntime?: ((name: string) => Promise<ProviderRuntimeMetadata | null>) | undefined | undefined;
  };
  if (typeof maybeRegistry.describeRuntime !== 'function') return [];

  try {
    return (await maybeRegistry.describeRuntime(providerId))?.auth?.routes ?? [];
  } catch (err: unknown) {
    logger.debug('[provider-routes] Failed to read provider runtime metadata', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
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
  const routes = await describeAuthRoutes(providerRegistry, providerId);
  const runtimeVia = getConfiguredViaFromRuntimeRoutes(routes);
  const configuredViaFromRegistry = getConfiguredVia(providerId, envVars, providerRegistry, secretKeys);
  const hasUsableRuntimeRoute = routes.some((route) => isRuntimeRouteUsable(route) && route.route !== 'none');
  const configuredVia = runtimeVia ?? configuredViaFromRegistry;
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
    const registryKey = current.registryKey ?? `${current.provider}:${current.id}`;
    model = { registryKey, provider: current.provider, id: current.id };

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
  // Group models by provider
  const byProvider = new Map<string, ProviderModelEntry[]>();
  for (const model of allModels) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    const registryKey = model.registryKey ?? `${model.provider}:${model.id}`;
    byProvider.get(model.provider)?.push({
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

  // F-PROV-009 (SDK 0.21.36): always emit `secretsResolutionSkipped` as a boolean so
  // consumers can reliably distinguish "secrets layer not consulted" from "no such field"
  // (prior optional-spread emission was undetectable from the consumer side).
  const body: ListProvidersResponse = {
    providers,
    currentModel,
    secretsResolutionSkipped: !secretsManager,
  };
  return Response.json(body);
}

// ---------------------------------------------------------------------------
// GET /api/providers/current
// ---------------------------------------------------------------------------

async function handleGetCurrentModel(context: ProviderRouteContext): Promise<Response> {
  const secretKeys = await resolveSecretKeys(context.secretsManager);
  return Response.json(await buildCurrentModelResponse(context.providerRegistry, secretKeys));
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
  return Response.json({ ...(await buildCurrentModelResponse(providerRegistry, secretKeys)), persisted });
}
