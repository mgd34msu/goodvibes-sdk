import type { ProviderRuntimeMetadata } from './interface.js';
import type { ModelDefinition, ProviderRegistry } from './registry.js';
import type { LLMProvider } from './interface.js';

export interface ProviderModelSnapshot {
  readonly id: string;
  readonly registryKey: string;
  readonly displayName: string;
  readonly selectable: boolean;
  readonly contextWindow: number;
  readonly tier?: string | undefined;
  readonly pricing?: {
    readonly inputPerMillionTokens: number;
    readonly outputPerMillionTokens: number;
    readonly currency: 'USD';
    /** Where the rates came from: 'user' (manual/registration — "your price"), 'provider' (served rates), 'catalog' (dated catalog). */
    readonly source: 'user' | 'provider' | 'catalog';
    /** ISO date (YYYY-MM-DD) of the catalog/provider pricing snapshot; absent for user prices. */
    readonly asOf?: string | undefined;
  };
}

export interface ProviderRuntimeSnapshot {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly runtime: ProviderRuntimeMetadata;
  readonly models: readonly ProviderModelSnapshot[];
}

export interface ProviderUsageSnapshot {
  readonly providerId: string;
  readonly active: boolean;
  readonly currentModelRegistryKey?: string | undefined;
  /**
   * Where the served prices came from: a single source when every priced
   * model agrees ('user' = manual/registration — "your price"; 'provider' =
   * provider-served rates; 'catalog' = the dated catalog), 'mixed' when they
   * disagree, or 'none' when no model carries pricing.
   */
  readonly pricingSource: 'user' | 'catalog' | 'provider' | 'mixed' | 'none';
  /** Oldest ISO date (YYYY-MM-DD) among the dated (catalog/provider) model prices served; absent when none carried a date. */
  readonly pricingAsOf?: string | undefined;
  readonly models: readonly ProviderModelSnapshot[];
  readonly usage: NonNullable<ProviderRuntimeMetadata['usage']>;
}

function toModelSnapshot(
  model: ModelDefinition,
  providerRegistry: Pick<ProviderRegistry, 'resolveModelPricing'>,
): ProviderModelSnapshot {
  // The ONE pricing resolver (manual -> registration -> provider-served ->
  // catalog -> honest unknown), so the price a surface renders here is the
  // price the platform actually charges with — carrying its provenance.
  const resolved = providerRegistry.resolveModelPricing(model.id, model.provider);
  return {
    id: model.id,
    registryKey: model.registryKey,
    displayName: model.displayName,
    selectable: model.selectable,
    contextWindow: model.contextWindow,
    ...(model.tier ? { tier: model.tier } : {}),
    ...(resolved.status === 'priced'
      ? {
          pricing: {
            inputPerMillionTokens: resolved.rates.inputPerMTok,
            outputPerMillionTokens: resolved.rates.outputPerMTok,
            currency: 'USD' as const,
            source: resolved.source,
            ...(resolved.asOf !== undefined ? { asOf: resolved.asOf } : {}),
          },
        }
      : {}),
  };
}

async function buildSnapshotForProvider(
  providerRegistry: Pick<ProviderRegistry, 'getRegistered' | 'getCurrentModel' | 'listModels' | 'resolveModelPricing' | 'describeRuntime'>,
  providerId: string,
): Promise<ProviderRuntimeSnapshot | null> {
  let provider: LLMProvider;
  try {
    provider = providerRegistry.getRegistered(providerId);
  } catch {
    return null;
  }
  const runtime = provider.describeRuntime
    ? await providerRegistry.describeRuntime(providerId)
    : {
        auth: { mode: 'none', configured: false, detail: 'Provider does not expose runtime metadata.' },
        models: { models: provider.models },
        usage: { streaming: true, toolCalling: true, parallelTools: false },
      } satisfies ProviderRuntimeMetadata;
  const resolvedRuntime = runtime ?? {
    auth: { mode: 'none', configured: false, detail: 'Provider does not expose runtime metadata.' },
    models: { models: provider.models },
    usage: { streaming: true, toolCalling: true, parallelTools: false },
  } satisfies ProviderRuntimeMetadata;
  // Read-only display path: never let an unresolved current model (e.g. a fresh
  // isolated home whose pricing catalog has not hydrated, so the configured
  // default has no materialized definition) turn this snapshot into a 500. Treat
  // an unresolvable current model as "no provider is active" rather than throwing.
  let currentModel: ModelDefinition | null;
  try {
    currentModel = providerRegistry.getCurrentModel();
  } catch {
    currentModel = null;
  }
  const models = providerRegistry
    .listModels()
    .filter((model) => model.provider === providerId)
    .map((model) => toModelSnapshot(model, providerRegistry));
  return {
    providerId,
    active: currentModel?.provider === providerId,
    modelCount: models.length,
    runtime: resolvedRuntime,
    models,
  };
}

export async function listProviderRuntimeSnapshots(
  providerRegistry: Pick<ProviderRegistry, 'listProviders' | 'getRegistered' | 'getCurrentModel' | 'listModels' | 'resolveModelPricing' | 'describeRuntime'>,
): Promise<readonly ProviderRuntimeSnapshot[]> {
  const snapshots = await Promise.all(providerRegistry.listProviders().map((provider) => buildSnapshotForProvider(providerRegistry, provider.name)));
  return snapshots.filter((snapshot): snapshot is ProviderRuntimeSnapshot => snapshot != null);
}

export async function getProviderRuntimeSnapshot(
  providerRegistry: Pick<ProviderRegistry, 'getRegistered' | 'getCurrentModel' | 'listModels' | 'resolveModelPricing' | 'describeRuntime'>,
  providerId: string,
): Promise<ProviderRuntimeSnapshot | null> {
  return buildSnapshotForProvider(providerRegistry, providerId);
}

export async function getProviderUsageSnapshot(
  providerRegistry: Pick<ProviderRegistry, 'getRegistered' | 'getCurrentModel' | 'listModels' | 'resolveModelPricing' | 'describeRuntime'>,
  providerId: string,
): Promise<ProviderUsageSnapshot | null> {
  const snapshot = await buildSnapshotForProvider(providerRegistry, providerId);
  if (!snapshot) return null;
  // Defense in depth alongside the same tolerance in buildSnapshotForProvider
  // above: even with the registry now resolving well-known defaults (see
  // ProviderRegistry.buildConfiguredModelFallback), a manually-configured or
  // otherwise still-unresolvable registryKey must not turn this second,
  // independent getCurrentModel() call into an unhandled throw. Degrade to
  // "no current model" instead of a 500.
  let currentModel: ModelDefinition | null;
  try {
    currentModel = providerRegistry.getCurrentModel();
  } catch {
    currentModel = null;
  }
  const usage = snapshot.runtime.usage ?? {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
  };
  // Provenance is derived from the models' own resolved prices: one shared
  // source reports as itself, disagreement reports 'mixed', and the as-of
  // date is the OLDEST dated snapshot served ("data at least as fresh as").
  const sources = new Set(snapshot.models.flatMap((model) => (model.pricing ? [model.pricing.source] : [])));
  const asOfDates = snapshot.models.flatMap((model) => (model.pricing?.asOf ? [model.pricing.asOf] : []));
  const pricingSource: ProviderUsageSnapshot['pricingSource'] = sources.size === 0
    ? (usage.cost?.source ?? 'none')
    : sources.size === 1
      ? [...sources][0]!
      : 'mixed';
  const pricingAsOf = asOfDates.length > 0 ? asOfDates.reduce((a, b) => (a < b ? a : b)) : undefined;
  return {
    providerId,
    active: snapshot.active,
    ...(currentModel?.provider === providerId ? { currentModelRegistryKey: currentModel.registryKey } : {}),
    pricingSource,
    ...(pricingAsOf !== undefined ? { pricingAsOf } : {}),
    models: snapshot.models,
    usage,
  };
}
