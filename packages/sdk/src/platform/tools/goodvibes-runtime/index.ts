import type { ConfigKey, ConfigSetting } from '../../config/schema.js';
import { isValidConfigKey } from '../../config/schema.js';
import { configKeyScope } from '../../config/config-ownership.js';
import {
  DaemonConfigRejectedError,
  DaemonConfigUnreachableError,
  resolveConfigWriteRoute,
} from '../../config/daemon-config-route.js';
import {
  applyRoutedConfigWrite,
  localStorePathForKey,
  readRoutedConfigValue,
  readRoutedConfigValues,
  resolveRouterDeps,
  type ConfigReadResult,
  type ConfigRoutingOptions,
} from './config-routing.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { ChannelPluginRegistry } from '../../channels/index.js';
import type { Tool, ToolDefinition } from '../../types/tools.js';
import type { ToolRegistry } from '../registry.js';
import { CloudflareControlPlaneManager } from '../../cloudflare/manager.js';
import type { CloudflareComponentSelection } from '../../cloudflare/types.js';
import { summarizeError } from '../../utils/error-display.js';

type JsonRecord = Record<string, unknown>;

export const GOODVIBES_RUNTIME_AWARENESS_PROMPT = [
  'You are running inside a GoodVibes host surface such as the TUI, daemon, companion app, Home Assistant, ntfy, Slack, or another configured client.',
  'Do not guess local settings, configured integrations, current provider/model, available tools, or host capabilities.',
  'For questions about GoodVibes settings, configured surfaces, available integrations, local harness state, Home Assistant, Cloudflare, ntfy, Slack, providers, models, tools, or what this runtime can do, call the goodvibes_context tool first.',
  'Do not spawn agents or WRFC chains for ordinary questions, environment inspection, or research that can be answered with direct tools in the current turn. Use agent/WRFC tools only when the user explicitly asks for delegated implementation, review, or multi-agent work.',
  // The previous wording here was "use goodvibes_settings only when the user
  // explicitly asks you to change a setting". A user who said "telegram bot id
  // is goodvibes_agent_bot" was read as not having explicitly asked, so the
  // value was noted in the reply and never written. He believed his system was
  // configured for hours. Supplying a value IS the ask. Kept terse on purpose:
  // this prompt is paid on every turn and competes with injected context.
  'A configuration value the user states — bot name, chat id, token, host, port, model, path — is a request to set it: call goodvibes_settings, then report the key and its persistedTo store. A value only repeated back in prose is not set.',
  'If the key or the intent is unclear, ask one short question; never write config the user did not ask for. Report settings from goodvibes_context with the store each came from; a value its owning runtime could not supply is unavailable, not unset.',
  'Never reveal raw secrets; report only redacted credential posture.',
].join('\n');

export function appendGoodVibesRuntimeAwarenessPrompt(systemPrompt?: string | null): string {
  const base = systemPrompt?.trim() ?? '';
  if (base.includes('goodvibes_context')) return base;
  return base ? `${base}\n\n${GOODVIBES_RUNTIME_AWARENESS_PROMPT}` : GOODVIBES_RUNTIME_AWARENESS_PROMPT;
}

export interface GoodVibesRuntimeToolDeps {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly channelRegistry?: ChannelPluginRegistry | null | undefined;
  readonly serviceRegistry?: Pick<ServiceRegistry, 'getAll' | 'inspect'> | null | undefined;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null | undefined;
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
  readonly surfaceRoot: string;
  /**
   * How to reach the runtime that owns a given setting. Reads and writes both
   * route through it, so a daemon-owned key is answered by the daemon rather
   * than by this client's copy of it.
   */
  readonly configRouting?: ConfigRoutingOptions | undefined;
}

export function createGoodVibesContextTool(deps: GoodVibesRuntimeToolDeps): Tool {
  const definition: ToolDefinition = {
    name: 'goodvibes_context',
    description:
      'Inspect the current GoodVibes runtime and host harness. Use before answering questions about settings, configured integrations, surfaces, providers, models, tools, Home Assistant, Cloudflare, ntfy, Slack, companion apps, or daemon/TUI capabilities. Returns redacted config only.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['summary', 'config_get', 'config_schema', 'integrations', 'tools', 'cloudflare_status', 'cloudflare_token_requirements'],
        },
        key: { type: 'string' },
        category: { type: 'string' },
        prefix: { type: 'string' },
        surface: { type: 'string' },
        includeSchema: { type: 'boolean' },
        includeParameters: { type: 'boolean' },
        includeBootstrap: { type: 'boolean' },
        components: { type: 'object', additionalProperties: { type: 'boolean' } },
        limit: { type: 'number' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    sideEffects: ['state'],
    concurrency: 'parallel',
  };

  async function execute(args: JsonRecord): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const mode = readString(args.mode);
      switch (mode) {
        case 'summary':
          return ok(await buildRuntimeSummary(deps));
        case 'config_get':
          return ok(await buildConfigSnapshot(deps, args));
        case 'config_schema':
          return ok(buildConfigSchema(deps, args));
        case 'integrations':
          return ok(await buildIntegrationSnapshot(deps, args));
        case 'tools':
          return ok(buildToolSnapshot(deps, args));
        case 'cloudflare_status':
          return ok({ cloudflare: redactCloudflareStatus(await createCloudflareManager(deps).describeStatus()) });
        case 'cloudflare_token_requirements':
          return ok({
            cloudflare: createCloudflareManager(deps).tokenRequirements({
              components: readComponents(args.components),
              includeBootstrap: args.includeBootstrap === true,
            }),
          });
        default:
          return { success: false, error: `Unknown goodvibes_context mode: ${String(args.mode)}` };
      }
    } catch (error) {
      return { success: false, error: summarizeError(error) };
    }
  }

  return { definition, execute };
}

export function createGoodVibesSettingsTool(
  deps: Pick<GoodVibesRuntimeToolDeps, 'configManager'> & { readonly configRouting?: ConfigRoutingOptions | undefined },
): Tool {
  const routing = deps.configRouting ?? {};
  const definition: ToolDefinition = {
    name: 'goodvibes_settings',
    description:
      'Apply a GoodVibes setting. When the user supplies a concrete configuration value — a bot username, a chat id, a host, a port, a model, a path — that is a request to set it: call this tool, then tell the user the key and the persistedTo store it landed in. A value only mentioned in your reply has not been set. '
      + 'The write is routed to the runtime that owns the key: daemon-owned settings (surfaces.*, control-plane binding, watchers, device pairing, provisioning, retention) go to the daemon\'s config, client-owned settings stay in this client\'s config. The value is then re-read from that store, so a write that did not land is reported as a failure rather than as success. '
      + 'If you cannot tell which key a stated value belongs to, ask one short question instead of guessing, and do not set anything the user did not ask for. '
      + 'Raw secret/token/password values are rejected: store the secret separately and set the key to a goodvibes:// secret reference.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['set', 'reset'] },
        key: { type: 'string' },
        value: {},
        confirm: { type: 'boolean' },
      },
      required: ['mode', 'key', 'confirm'],
      additionalProperties: false,
    },
    sideEffects: ['state'],
    concurrency: 'serial',
  };

  async function execute(args: JsonRecord): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (args.confirm !== true) {
        return { success: false, error: 'Set confirm=true to change GoodVibes settings.' };
      }
      const key = readString(args.key);
      if (!key || !isValidConfigKey(key)) {
        return { success: false, error: `Unknown config key: ${key || '<missing>'}` };
      }
      const before = await readRoutedConfigValue(deps.configManager, key, routing);
      const previous = before.available ? redactConfigValue(key, before.value) : { unavailable: true };

      if (args.mode === 'reset') {
        return await resetRoutedSetting(deps.configManager, key, previous, routing);
      }
      if (args.mode !== 'set') {
        return { success: false, error: `Unknown goodvibes_settings mode: ${String(args.mode)}` };
      }
      if (isSensitiveConfigKey(key) && rejectsRawSecretValue(args.value)) {
        return {
          success: false,
          error: `Refusing to persist a raw credential in ${key}. Store it as a GoodVibes secret and set this key to a goodvibes:// secret reference.`,
        };
      }

      // Route by ownership, then re-read from the OWNING store.
      //
      // `get()` after `set()` reads the in-process object, so it says "yes,
      // that's the value" even when the bytes never landed, landed in a store
      // nothing reads, or are shadowed on reload by a project overlay. Worse,
      // this client's store is not the store that acts on a daemon-owned key:
      // a Telegram bot username written here configures nothing, because
      // Telegram runs in the daemon. Both failures report success and cost the
      // user hours of believing the system is configured. So the write goes to
      // the owning runtime and the value is read back from there.
      const applied = await applyRoutedConfigWrite(deps.configManager, key, args.value, routing);
      return ok({
        key,
        action: 'set',
        previous,
        current: redactConfigValue(key, applied.value),
        // Name the exact store. A host reading a different root will not see it.
        persistedTo: applied.persistedTo,
        appliedBy: applied.appliedBy,
        owner: applied.scope,
        ownership: applied.ownership,
        verifiedInOwningStore: true,
      });
    } catch (error) {
      // Routing failures already say which key, which runtime, and that nothing
      // was applied. `summarizeError` would flatten that into "Cannot connect to
      // the provider", which is how a config failure ends up looking like a
      // network blip instead of an unset setting.
      return { success: false, error: describeSettingsFailure(error) };
    }
  }

  return { definition, execute };
}

/** Keep an explanatory routing error intact; summarize anything unrecognized. */
function describeSettingsFailure(error: unknown): string {
  if (error instanceof DaemonConfigUnreachableError || error instanceof DaemonConfigRejectedError) return error.message;
  if (error instanceof Error && /\bNOT (applied|in )/.test(error.message)) return error.message;
  return summarizeError(error);
}

/**
 * Reset routes like a set. With the daemon reachable and remote, "reset" is
 * delivered as a write of the schema default, because the local file the reset
 * would clear is not the store the daemon reads.
 */
async function resetRoutedSetting(
  configManager: ConfigManager,
  key: ConfigKey,
  previous: unknown,
  routing: ConfigRoutingOptions,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const route = resolveConfigWriteRoute(key, resolveRouterDeps(configManager, routing));
  if (route.mode === 'daemon') {
    const setting = configManager.getSchema().find((entry) => entry.key === key);
    if (!setting) return { success: false, error: `No schema default is known for ${key}, so it cannot be reset.` };
    const applied = await applyRoutedConfigWrite(configManager, key, setting.default, routing);
    return ok({
      key,
      action: 'reset',
      previous,
      current: redactConfigValue(key, applied.value),
      persistedTo: applied.persistedTo,
      appliedBy: applied.appliedBy,
      owner: applied.scope,
      ownership: applied.ownership,
      verifiedInOwningStore: true,
    });
  }
  configManager.reset(key);
  return ok({
    key,
    action: 'reset',
    previous,
    current: redactConfigValue(key, configManager.get(key)),
    persistedTo: localStorePathForKey(configManager, key),
    appliedBy: 'local',
    owner: configKeyScope(key),
    ownership: route.reason,
  });
}

async function buildRuntimeSummary(deps: GoodVibesRuntimeToolDeps): Promise<JsonRecord> {
  const currentModel = safeCall(() => deps.providerRegistry.getCurrentModel());
  const cloudflareStatus = await safeAsync(() => createCloudflareManager(deps).describeStatus());
  const channels = await safeAsync(async () => ({
    descriptors: deps.channelRegistry?.listDescriptors() ?? [],
    status: deps.channelRegistry ? await deps.channelRegistry.listStatus() : [],
  }));
  return {
    runtime: {
      surfaceRoot: deps.surfaceRoot,
      workingDirectory: deps.workingDirectory,
      homeDirectory: deps.homeDirectory ?? null,
    },
    provider: currentModel
      ? {
          current: {
            id: currentModel.id,
            provider: currentModel.provider,
            registryKey: currentModel.registryKey,
            displayName: currentModel.displayName,
          },
          providerCount: deps.providerRegistry.listProviders().length,
          modelCount: deps.providerRegistry.listModels().length,
          configuredProviderIds: deps.providerRegistry.getConfiguredProviderIds(),
        }
      : null,
    settings: {
      keyCount: deps.configManager.getSchema().length,
      categories: listConfigCategories(deps.configManager.getSchema()),
      readTool: 'goodvibes_context',
      writeTool: 'goodvibes_settings',
      secrets: 'redacted',
    },
    integrations: {
      channels: channels.value ?? channels.error,
      cloudflare: cloudflareStatus.value ? redactCloudflareStatus(cloudflareStatus.value) : { error: cloudflareStatus.error },
      batch: {
        mode: deps.configManager.get('batch.mode'),
        queueBackend: deps.configManager.get('batch.queueBackend'),
      },
      tts: {
        provider: deps.configManager.get('tts.provider'),
        voice: deps.configManager.get('tts.voice') ? 'configured' : 'default',
      },
    },
    tools: {
      count: deps.toolRegistry.list().length,
      names: deps.toolRegistry.list().map((tool) => tool.definition.name).sort(),
    },
  };
}

/**
 * The effective merged view: each row carries the value held by the runtime that
 * OWNS it, plus the store that value came from.
 *
 * Reading only this client's store is why the same key looked blank in one place
 * and set in another with nothing saying why — a daemon-owned key set in the
 * daemon's config is invisible to a client that reads its own file, and the
 * honest-looking answer "not set" was simply wrong. Rows whose owning runtime
 * could not be reached are marked unavailable with the reason rather than
 * falling back to a default, because a default shown as the current setting
 * cannot be told apart from the truth.
 */
async function buildConfigSnapshot(deps: GoodVibesRuntimeToolDeps, args: JsonRecord): Promise<JsonRecord> {
  const schema = selectSchema(deps.configManager.getSchema(), args);
  const reads = await readRoutedConfigValues(
    deps.configManager,
    schema.map((setting) => setting.key),
    deps.configRouting ?? {},
  );
  const includeSchema = args.includeSchema !== false;
  const settings = schema.map((setting, index) => describeSetting(setting, reads[index]!, includeSchema));
  const unreachable = reads.filter((read): read is Extract<ConfigReadResult, { available: false }> => !read.available);
  return {
    settings,
    ...(unreachable.length > 0
      ? {
          unavailable: {
            count: unreachable.length,
            reason: unreachable[0]!.reason,
            note: 'These settings are owned by a runtime this host could not reach. Do not report them as unset.',
          },
        }
      : {}),
    redaction: 'Values whose key or content looks like a credential are redacted. Raw secrets are never returned.',
  };
}

function buildConfigSchema(deps: GoodVibesRuntimeToolDeps, args: JsonRecord): JsonRecord {
  return {
    settings: selectSchema(deps.configManager.getSchema(), args).map((setting) => ({
      key: setting.key,
      category: setting.key.split('.')[0],
      type: setting.type,
      default: redactConfigValue(setting.key, setting.default),
      description: setting.description,
      ...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
    })),
  };
}

async function buildIntegrationSnapshot(deps: GoodVibesRuntimeToolDeps, args: JsonRecord): Promise<JsonRecord> {
  const surface = readString(args.surface);
  const channelRegistry = deps.channelRegistry ?? null;
  const channels = channelRegistry
    ? {
        descriptors: channelRegistry.listDescriptors().filter((entry) => !surface || entry.surface === surface),
        status: (await channelRegistry.listStatus()).filter((entry) => !surface || entry.surface === surface),
        capabilities: await channelRegistry.listCapabilities(surface as never),
        tools: await channelRegistry.listTools(surface as never),
      }
    : null;
  const services = deps.serviceRegistry
    ? await inspectServices(deps.serviceRegistry)
    : [];
  return {
    channels,
    services,
    cloudflare: redactCloudflareStatus(await createCloudflareManager(deps).describeStatus()),
    configuredSurfaces: listSurfaceConfig(deps.configManager),
  };
}

function buildToolSnapshot(deps: GoodVibesRuntimeToolDeps, args: JsonRecord): JsonRecord {
  const includeParameters = args.includeParameters === true;
  const limit = clampLimit(args.limit, 250, 1000);
  const tools = deps.toolRegistry.list()
    .map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      sideEffects: tool.definition.sideEffects ?? [],
      concurrency: tool.definition.concurrency ?? 'parallel',
      supportsProgress: tool.definition.supportsProgress ?? false,
      supportsStreamingOutput: tool.definition.supportsStreamingOutput ?? false,
      ...(includeParameters ? { parameters: tool.definition.parameters } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
  return { tools, returned: tools.length, total: deps.toolRegistry.list().length };
}

function describeSetting(setting: ConfigSetting, read: ConfigReadResult, includeSchema: boolean): JsonRecord {
  if (!read.available) {
    return {
      key: setting.key,
      category: setting.key.split('.')[0],
      available: false,
      owner: read.scope,
      source: read.source,
      reason: read.reason,
    };
  }
  const value = read.value;
  return {
    key: setting.key,
    category: setting.key.split('.')[0],
    value: redactConfigValue(setting.key, value),
    configured: !valuesEqual(value, setting.default),
    // Which store answered. Two surfaces disagreeing about one key is not a
    // mystery when every value says where it came from.
    owner: read.scope,
    source: read.source,
    readFrom: read.readFrom,
    ...(includeSchema
      ? {
          type: setting.type,
          default: redactConfigValue(setting.key, setting.default),
          description: setting.description,
          ...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
        }
      : {}),
  };
}

function selectSchema(schema: readonly ConfigSetting[], args: JsonRecord): ConfigSetting[] {
  const key = readString(args.key);
  if (key) return isValidConfigKey(key) ? schema.filter((setting) => setting.key === key) : [];
  const prefix = readString(args.prefix);
  const category = readString(args.category);
  return schema.filter((setting) => {
    if (prefix && !setting.key.startsWith(prefix)) return false;
    if (category && setting.key.split('.')[0] !== category) return false;
    return true;
  });
}

function listConfigCategories(schema: readonly ConfigSetting[]): string[] {
  return [...new Set(schema.map((setting) => setting.key.split('.')[0]!))].sort();
}

function listSurfaceConfig(configManager: ConfigManager): JsonRecord[] {
  const surfaces = new Map<string, JsonRecord>();
  for (const setting of configManager.getSchema()) {
    const match = /^surfaces\.([^.]+)\.(.+)$/.exec(setting.key);
    if (!match) continue;
    const [, surface, field] = match;
    const entry = surfaces.get(surface!) ?? { surface, settings: {} };
    const settings = entry.settings as JsonRecord;
    if (field !== undefined) { settings[field] = redactConfigValue(setting.key, configManager.get(setting.key)); }
    surfaces.set(surface!, entry);
  }
  return [...surfaces.values()].sort((a, b) => String(a.surface).localeCompare(String(b.surface)));
}

async function inspectServices(serviceRegistry: Pick<ServiceRegistry, 'getAll' | 'inspect'>): Promise<JsonRecord[]> {
  const services = serviceRegistry.getAll();
  const records: JsonRecord[] = [];
  for (const [id, config] of Object.entries(services)) {
    const inspection = await serviceRegistry.inspect(id);
    records.push({
      id,
      name: config.name || id,
      authType: config.authType,
      baseUrl: config.baseUrl ?? null,
      hasPrimaryCredential: inspection?.hasPrimaryCredential ?? false,
      hasWebhookUrl: inspection?.hasWebhookUrl ?? false,
      hasSigningSecret: inspection?.hasSigningSecret ?? false,
      hasAppToken: inspection?.hasAppToken ?? false,
    });
  }
  return records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function createCloudflareManager(deps: GoodVibesRuntimeToolDeps): CloudflareControlPlaneManager {
  return new CloudflareControlPlaneManager({
    configManager: deps.configManager,
    secretsManager: deps.secretsManager ?? null,
  });
}

function redactCloudflareStatus(status: unknown): JsonRecord {
  const record = status && typeof status === 'object' ? status as JsonRecord : {};
  return {
    ...record,
    config: redactObjectByPath('cloudflare', record.config),
  };
}

function redactObjectByPath(prefix: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry, index) => redactObjectByPath(`${prefix}.${index}`, entry));
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    out[key] = redactConfigValue(`${prefix}.${key}`, entry);
  }
  return out;
}

function redactConfigValue(key: string, value: unknown): unknown {
  if (!isSensitiveConfigKey(key) && !looksLikeSecretValue(value)) return value;
  if (value === null || value === undefined || value === '') {
    return { redacted: true, configured: false };
  }
  return {
    redacted: true,
    configured: true,
    source: typeof value === 'string' && value.startsWith('goodvibes://') ? 'goodvibes-secret-ref' : 'credential-like-value',
  };
}

function isSensitiveConfigKey(key: string): boolean {
  return /(api[_-]?key|token|secret|password|passwd|private[_-]?key|authorization|credential|accessToken|botToken|appToken|signingSecret|webhookSecret)/i.test(key);
}

function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\b(Bearer\s+[A-Za-z0-9._-]{12,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(value);
}

function rejectsRawSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return value !== '' && value !== null && value !== undefined;
  if (!value.trim()) return false;
  return !value.trim().startsWith('goodvibes://');
}

function readComponents(value: unknown): CloudflareComponentSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const components: CloudflareComponentSelection = {};
  for (const [key, raw] of Object.entries(value as JsonRecord)) {
    if (typeof raw === 'boolean') components[key as keyof CloudflareComponentSelection] = raw;
  }
  return components;
}

function ok(value: unknown): { success: true; output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  return Math.max(1, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}
