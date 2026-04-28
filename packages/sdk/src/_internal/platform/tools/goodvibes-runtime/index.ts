import type { ConfigKey, ConfigSetting } from '../../config/schema.js';
import { isValidConfigKey } from '../../config/schema.js';
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
  'Use goodvibes_settings only when the user explicitly asks you to change a setting. Never reveal raw secrets; report only redacted credential posture.',
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
  readonly channelRegistry?: ChannelPluginRegistry | null;
  readonly serviceRegistry?: Pick<ServiceRegistry, 'getAll' | 'inspect'> | null;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'set' | 'getGlobalHome'> | null;
  readonly workingDirectory: string;
  readonly homeDirectory?: string;
  readonly surfaceRoot: string;
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
          return ok(buildConfigSnapshot(deps, args));
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

export function createGoodVibesSettingsTool(deps: Pick<GoodVibesRuntimeToolDeps, 'configManager'>): Tool {
  const definition: ToolDefinition = {
    name: 'goodvibes_settings',
    description:
      'Change GoodVibes settings through the SDK config manager. Use only when the user explicitly asks to set or reset a setting. Raw secret/token/password values are rejected; store secrets separately and set settings to secret references.',
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
      const previous = deps.configManager.get(key);
      if (args.mode === 'reset') {
        deps.configManager.reset(key);
        return ok({
          key,
          action: 'reset',
          previous: redactConfigValue(key, previous),
          current: redactConfigValue(key, deps.configManager.get(key)),
        });
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
      deps.configManager.setDynamic(key, args.value);
      return ok({
        key,
        action: 'set',
        previous: redactConfigValue(key, previous),
        current: redactConfigValue(key, deps.configManager.get(key)),
      });
    } catch (error) {
      return { success: false, error: summarizeError(error) };
    }
  }

  return { definition, execute };
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
            registryKey: currentModel.registryKey ?? `${currentModel.provider}:${currentModel.id}`,
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

function buildConfigSnapshot(deps: GoodVibesRuntimeToolDeps, args: JsonRecord): JsonRecord {
  const schema = selectSchema(deps.configManager.getSchema(), args);
  return {
    settings: schema.map((setting) => describeSetting(deps.configManager, setting, args.includeSchema !== false)),
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

function describeSetting(configManager: ConfigManager, setting: ConfigSetting, includeSchema: boolean): JsonRecord {
  const value = safeCall(() => configManager.get(setting.key));
  return {
    key: setting.key,
    category: setting.key.split('.')[0],
    value: redactConfigValue(setting.key, value),
    configured: !valuesEqual(value, setting.default),
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
  return [...new Set(schema.map((setting) => setting.key.split('.')[0]))].sort();
}

function listSurfaceConfig(configManager: ConfigManager): JsonRecord[] {
  const surfaces = new Map<string, JsonRecord>();
  for (const setting of configManager.getSchema()) {
    const match = /^surfaces\.([^.]+)\.(.+)$/.exec(setting.key);
    if (!match) continue;
    const [, surface, field] = match;
    const entry = surfaces.get(surface) ?? { surface, settings: {} };
    const settings = entry.settings as JsonRecord;
    settings[field] = redactConfigValue(setting.key, configManager.get(setting.key));
    surfaces.set(surface, entry);
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
