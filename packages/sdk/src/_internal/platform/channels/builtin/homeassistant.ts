import { resolveSecretInput } from '../../config/secret-refs.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { HomeAssistantIntegration } from '../../integrations/homeassistant.js';
import type {
  ChannelOperatorActionDescriptor,
  ChannelSurface,
  ChannelToolDescriptor,
} from '../types.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';

export const HOME_ASSISTANT_SURFACE = 'homeassistant' as const satisfies ChannelSurface;
export const HOME_ASSISTANT_WEBHOOK_PATH = '/webhook/homeassistant';
export const HOME_ASSISTANT_DEFAULT_EVENT_TYPE = 'goodvibes_message';

interface ConfigReader {
  get(key: string): unknown;
}

const HOME_ASSISTANT_TOKEN_ENV = [
  'HOMEASSISTANT_ACCESS_TOKEN',
  'HOME_ASSISTANT_ACCESS_TOKEN',
  'HA_ACCESS_TOKEN',
] as const;

const HOME_ASSISTANT_URL_ENV = [
  'HOMEASSISTANT_URL',
  'HOME_ASSISTANT_URL',
  'HA_URL',
] as const;

const HOME_ASSISTANT_WEBHOOK_SECRET_ENV = [
  'HOMEASSISTANT_WEBHOOK_SECRET',
  'HOME_ASSISTANT_WEBHOOK_SECRET',
  'HA_GOODVIBES_WEBHOOK_SECRET',
] as const;

interface HomeAssistantActionContext {
  readonly deps: BuiltinChannelRuntimeDeps;
}

export interface HomeAssistantSurfaceManifest {
  readonly protocolVersion: number;
  readonly surface: 'homeassistant';
  readonly label: string;
  readonly device: {
    readonly identifiers: readonly string[];
    readonly manufacturer: string;
    readonly model: string;
    readonly name: string;
    readonly swVersion?: string;
  };
  readonly daemon: {
    readonly baseUrl: string;
    readonly auth: 'bearer';
    readonly endpoints: Record<string, string>;
  };
  readonly capabilities: readonly string[];
  readonly events: {
    readonly outboundEventType: string;
    readonly inboundWebhookPath: string;
    readonly inboundSecretHeaders: readonly string[];
  };
  readonly recommendedServices: readonly {
    readonly name: string;
    readonly target: 'config_entry' | 'device' | 'entity';
    readonly description: string;
  }[];
  readonly metadata: Record<string, unknown>;
}

export function listHomeAssistantOperatorActions(): ChannelOperatorActionDescriptor[] {
  const surface = HOME_ASSISTANT_SURFACE;
  return [
    action(surface, 'homeassistant-manifest', 'Home Assistant manifest', 'Return the daemon/device contract consumed by the Home Assistant integration.'),
    action(surface, 'homeassistant-status', 'Check Home Assistant', 'Check configured Home Assistant API reachability and token posture.'),
    action(surface, 'homeassistant-list-states', 'List Home Assistant states', 'List current Home Assistant entity states with optional domain filtering.'),
    action(surface, 'homeassistant-list-automations', 'List Home Assistant automations', 'List Home Assistant automation entities and their current states.'),
    action(surface, 'homeassistant-get-state', 'Get Home Assistant state', 'Read a single Home Assistant entity state.', {
      type: 'object',
      properties: { entityId: { type: 'string' } },
      required: ['entityId'],
    }),
    action(surface, 'homeassistant-list-services', 'List Home Assistant services', 'List callable Home Assistant service actions.'),
    action(surface, 'homeassistant-call-service', 'Call Home Assistant service', 'Call a Home Assistant service action such as light.turn_on.', {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        service: { type: 'string' },
        serviceData: { type: 'object', additionalProperties: true },
        returnResponse: { type: 'boolean' },
      },
      required: ['domain', 'service'],
      additionalProperties: true,
    }, true),
    action(surface, 'homeassistant-fire-event', 'Fire Home Assistant event', 'Fire an event on the Home Assistant event bus.', {
      type: 'object',
      properties: {
        eventType: { type: 'string' },
        eventData: { type: 'object', additionalProperties: true },
      },
      required: ['eventType'],
      additionalProperties: true,
    }, true),
    action(surface, 'homeassistant-render-template', 'Render Home Assistant template', 'Render a Home Assistant template through the configured instance.', {
      type: 'object',
      properties: {
        template: { type: 'string' },
        variables: { type: 'object', additionalProperties: true },
      },
      required: ['template'],
      additionalProperties: true,
    }),
    action(surface, 'homeassistant-publish-goodvibes-event', 'Publish GoodVibes event', 'Publish a GoodVibes message event into Home Assistant.', {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['body'],
      additionalProperties: true,
    }),
  ];
}

export function listHomeAssistantTools(): ChannelToolDescriptor[] {
  const surface = HOME_ASSISTANT_SURFACE;
  return [
    tool(surface, 'homeassistant:manifest', 'homeassistant_manifest', 'Return the Home Assistant integration manifest and daemon endpoint contract.', ['homeassistant-manifest']),
    tool(surface, 'homeassistant:status', 'homeassistant_status', 'Check Home Assistant API reachability and token posture.', ['homeassistant-status']),
    tool(surface, 'homeassistant:states', 'homeassistant_states', 'List Home Assistant entity states.', ['homeassistant-list-states'], {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    }),
    tool(surface, 'homeassistant:automations', 'homeassistant_automations', 'List Home Assistant automation entities and current states.', ['homeassistant-list-automations'], {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    }),
    tool(surface, 'homeassistant:state', 'homeassistant_state', 'Read one Home Assistant entity state.', ['homeassistant-get-state'], {
      type: 'object',
      properties: { entityId: { type: 'string' } },
      required: ['entityId'],
      additionalProperties: false,
    }),
    tool(surface, 'homeassistant:services', 'homeassistant_services', 'List callable Home Assistant service actions.', ['homeassistant-list-services']),
    tool(surface, 'homeassistant:call_service', 'homeassistant_call_service', 'Call a Home Assistant service action.', ['homeassistant-call-service'], {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        service: { type: 'string' },
        serviceData: { type: 'object', additionalProperties: true },
        returnResponse: { type: 'boolean' },
      },
      required: ['domain', 'service'],
      additionalProperties: true,
    }),
    tool(surface, 'homeassistant:fire_event', 'homeassistant_fire_event', 'Fire an event on the Home Assistant event bus.', ['homeassistant-fire-event'], {
      type: 'object',
      properties: {
        eventType: { type: 'string' },
        eventData: { type: 'object', additionalProperties: true },
      },
      required: ['eventType'],
      additionalProperties: true,
    }),
    tool(surface, 'homeassistant:render_template', 'homeassistant_render_template', 'Render a Home Assistant template.', ['homeassistant-render-template'], {
      type: 'object',
      properties: {
        template: { type: 'string' },
        variables: { type: 'object', additionalProperties: true },
      },
      required: ['template'],
      additionalProperties: true,
    }),
  ];
}

export async function runHomeAssistantOperatorAction(
  context: HomeAssistantActionContext,
  actionId: string,
  input?: Record<string, unknown>,
): Promise<{ readonly handled: boolean; readonly result: unknown }> {
  switch (actionId) {
    case 'homeassistant-manifest':
      return { handled: true, result: buildHomeAssistantManifest(context.deps) };
    case 'homeassistant-status':
      return { handled: true, result: await checkHomeAssistantStatus(context.deps) };
    case 'homeassistant-list-states':
      return { handled: true, result: await listHomeAssistantStates(context.deps, input) };
    case 'homeassistant-list-automations':
      return { handled: true, result: await listHomeAssistantStates(context.deps, { ...input, domain: 'automation' }) };
    case 'homeassistant-get-state':
      return { handled: true, result: await getHomeAssistantState(context.deps, input) };
    case 'homeassistant-list-services':
      return { handled: true, result: await listHomeAssistantServices(context.deps) };
    case 'homeassistant-call-service':
      return { handled: true, result: await callHomeAssistantService(context.deps, input) };
    case 'homeassistant-fire-event':
      return { handled: true, result: await fireHomeAssistantEvent(context.deps, input) };
    case 'homeassistant-render-template':
      return { handled: true, result: await renderHomeAssistantTemplate(context.deps, input) };
    case 'homeassistant-publish-goodvibes-event':
      return { handled: true, result: await publishGoodVibesEvent(context.deps, input) };
    default:
      return { handled: false, result: null };
  }
}

export function buildHomeAssistantManifest(deps: Pick<BuiltinChannelRuntimeDeps, 'configManager'>): HomeAssistantSurfaceManifest {
  const baseUrl = firstNonEmpty(
    String(deps.configManager.get('controlPlane.baseUrl') ?? ''),
    String(deps.configManager.get('web.publicBaseUrl') ?? ''),
  ) ?? '';
  const eventType = String(deps.configManager.get('surfaces.homeassistant.eventType') ?? HOME_ASSISTANT_DEFAULT_EVENT_TYPE);
  const deviceId = String(deps.configManager.get('surfaces.homeassistant.deviceId') ?? 'goodvibes-daemon') || 'goodvibes-daemon';
  return {
    protocolVersion: 1,
    surface: HOME_ASSISTANT_SURFACE,
    label: 'Home Assistant',
    device: {
      identifiers: [`goodvibes:${deviceId}`],
      manufacturer: 'GoodVibes',
      model: 'GoodVibes Daemon',
      name: String(deps.configManager.get('surfaces.homeassistant.deviceName') ?? 'GoodVibes Daemon') || 'GoodVibes Daemon',
    },
    daemon: {
      baseUrl,
      auth: 'bearer',
      endpoints: {
        setup: '/api/channels/setup/homeassistant',
        account: '/api/channels/accounts/homeassistant',
        capabilities: '/api/channels/capabilities/homeassistant',
        tools: '/api/channels/tools/homeassistant',
        agentTools: '/api/channels/agent-tools/homeassistant',
        actions: '/api/channels/actions/homeassistant',
        directory: '/api/channels/directory/homeassistant',
        resolveTarget: '/api/channels/targets/homeassistant/resolve',
        webhook: HOME_ASSISTANT_WEBHOOK_PATH,
        conversation: '/api/homeassistant/conversation',
        conversationStream: '/api/homeassistant/conversation/stream',
        conversationCancel: '/api/homeassistant/conversation/cancel',
        health: '/api/homeassistant/health',
        eventStream: '/api/control-plane/events',
      },
    },
    capabilities: [
      'conversation-ingress',
      'daemon-tool-catalog',
      'daemon-agent-tools',
      'session-binding',
      'conversation-submit-wait',
      'conversation-stream',
      'conversation-cancel',
      'stable-correlation',
      'remote-session-ttl',
      'homeassistant-state-read',
      'homeassistant-service-call',
      'homeassistant-event-delivery',
      'control-plane-events',
    ],
    events: {
      outboundEventType: eventType,
      inboundWebhookPath: HOME_ASSISTANT_WEBHOOK_PATH,
      inboundSecretHeaders: ['x-goodvibes-homeassistant-secret', 'authorization'],
    },
    recommendedServices: [
      { name: 'goodvibes.prompt', target: 'config_entry', description: 'Submit a normal prompt through an isolated daemon chat session.' },
      { name: 'goodvibes.cancel', target: 'config_entry', description: 'Cancel an active Home Assistant conversation session.' },
      { name: 'goodvibes.status', target: 'config_entry', description: 'Inspect daemon and Home Assistant conversation status.' },
    ],
    metadata: {
      configKeys: [
        'surfaces.homeassistant.enabled',
        'surfaces.homeassistant.instanceUrl',
        'surfaces.homeassistant.accessToken',
        'surfaces.homeassistant.webhookSecret',
        'surfaces.homeassistant.eventType',
        'surfaces.homeassistant.remoteSessionTtlMs',
      ],
      remoteSessionTtlMs: Number(deps.configManager.get('surfaces.homeassistant.remoteSessionTtlMs') ?? 20 * 60_000),
    },
  };
}

export async function createHomeAssistantClient(deps: BuiltinChannelRuntimeDeps): Promise<HomeAssistantIntegration> {
  const baseUrl = resolveHomeAssistantBaseUrl(deps.configManager, deps.serviceRegistry);
  if (!baseUrl) {
    throw new Error('Home Assistant instance URL is not configured.');
  }
  const accessToken = await resolveHomeAssistantAccessToken(deps);
  return new HomeAssistantIntegration({
    baseUrl,
    accessToken: accessToken ?? undefined,
  });
}

export function resolveHomeAssistantBaseUrl(
  configManager: ConfigReader,
  serviceRegistry?: Pick<ServiceRegistry, 'get'>,
): string | null {
  return firstNonEmpty(
    String(configManager.get('surfaces.homeassistant.instanceUrl') ?? ''),
    serviceRegistry?.get('homeassistant')?.baseUrl,
    ...HOME_ASSISTANT_URL_ENV.map((key) => process.env[key]),
  ) ?? null;
}

export async function resolveHomeAssistantAccessToken(deps: {
  readonly configManager: ConfigReader;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly serviceRegistry?: Pick<ServiceRegistry, 'resolveSecret'>;
}): Promise<string | null> {
  return await deps.serviceRegistry?.resolveSecret('homeassistant', 'primary')
    || await resolveConfiguredSecret(deps, deps.configManager.get('surfaces.homeassistant.accessToken'))
    || firstNonEmpty(...HOME_ASSISTANT_TOKEN_ENV.map((key) => process.env[key]))
    || null;
}

export async function resolveHomeAssistantWebhookSecret(deps: {
  readonly configManager: ConfigReader;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly serviceRegistry?: Pick<ServiceRegistry, 'resolveSecret'>;
}): Promise<string | null> {
  return await deps.serviceRegistry?.resolveSecret('homeassistant', 'signingSecret')
    || await resolveConfiguredSecret(deps, deps.configManager.get('surfaces.homeassistant.webhookSecret'))
    || firstNonEmpty(...HOME_ASSISTANT_WEBHOOK_SECRET_ENV.map((key) => process.env[key]))
    || null;
}

async function checkHomeAssistantStatus(deps: BuiltinChannelRuntimeDeps): Promise<Record<string, unknown>> {
  const baseUrl = resolveHomeAssistantBaseUrl(deps.configManager, deps.serviceRegistry);
  const token = await resolveHomeAssistantAccessToken(deps);
  if (!baseUrl) return { ok: false, configured: false, error: 'Home Assistant instance URL is not configured.' };
  const client = new HomeAssistantIntegration({ baseUrl, accessToken: token ?? undefined });
  try {
    const api = await client.getApiStatus();
    return {
      ok: true,
      configured: Boolean(token),
      baseUrl,
      api,
    };
  } catch (error) {
    return {
      ok: false,
      configured: Boolean(token),
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function listHomeAssistantStates(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const states = await (await createHomeAssistantClient(deps)).listStates();
  const domain = readString(input?.domain)?.replace(/\.$/, '');
  const query = readString(input?.query)?.toLowerCase();
  const limit = clampLimit(input?.limit, 100, 500);
  const filtered = states.filter((state) => {
    if (domain && !state.entity_id.startsWith(`${domain}.`)) return false;
    if (!query) return true;
    return state.entity_id.toLowerCase().includes(query)
      || state.state.toLowerCase().includes(query)
      || JSON.stringify(state.attributes ?? {}).toLowerCase().includes(query);
  }).slice(0, limit);
  return { ok: true, total: states.length, returned: filtered.length, states: filtered };
}

async function getHomeAssistantState(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entityId = readString(input?.entityId ?? input?.entity_id);
  if (!entityId) return { ok: false, error: 'entityId is required.' };
  const state = await (await createHomeAssistantClient(deps)).getState(entityId);
  return state ? { ok: true, state } : { ok: false, error: `No Home Assistant state found for ${entityId}.` };
}

async function listHomeAssistantServices(deps: BuiltinChannelRuntimeDeps): Promise<Record<string, unknown>> {
  const services = await (await createHomeAssistantClient(deps)).listServices();
  return { ok: true, services };
}

async function callHomeAssistantService(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const domain = readString(input?.domain);
  const service = readString(input?.service);
  if (!domain || !service) return { ok: false, error: 'domain and service are required.' };
  const serviceData = readRecord(input?.serviceData ?? input?.service_data);
  const result = await (await createHomeAssistantClient(deps)).callService({
    domain,
    service,
    ...(serviceData ? { serviceData } : {}),
    ...(typeof input?.returnResponse === 'boolean' ? { returnResponse: input.returnResponse } : {}),
  });
  return { ok: true, result };
}

async function fireHomeAssistantEvent(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const eventType = readString(input?.eventType ?? input?.event_type);
  if (!eventType) return { ok: false, error: 'eventType is required.' };
  const result = await (await createHomeAssistantClient(deps)).fireEvent(eventType, readRecord(input?.eventData ?? input?.event_data) ?? {});
  return { ok: true, result };
}

async function renderHomeAssistantTemplate(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const template = readString(input?.template);
  if (!template) return { ok: false, error: 'template is required.' };
  const rendered = await (await createHomeAssistantClient(deps)).renderTemplate(template, readRecord(input?.variables) ?? undefined);
  return { ok: true, rendered };
}

async function publishGoodVibesEvent(deps: BuiltinChannelRuntimeDeps, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = readString(input?.body ?? input?.message ?? input?.text);
  if (!body) return { ok: false, error: 'body is required.' };
  const eventType = readString(input?.eventType ?? input?.event_type)
    ?? String(deps.configManager.get('surfaces.homeassistant.eventType') || HOME_ASSISTANT_DEFAULT_EVENT_TYPE);
  const result = await (await createHomeAssistantClient(deps)).publishGoodVibesEvent(eventType, {
    type: readString(input?.type) ?? 'message',
    body,
    title: readString(input?.title),
    status: readString(input?.status),
    metadata: readRecord(input?.metadata) ?? {},
  });
  return { ok: true, eventType, result };
}

async function resolveConfiguredSecret(
  deps: {
    readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  },
  value: unknown,
): Promise<string | null> {
  return resolveSecretInput(value, {
    resolveLocalSecret: deps.secretsManager ? (key) => deps.secretsManager!.get(key) : undefined,
    homeDirectory: deps.secretsManager?.getGlobalHome?.() ?? undefined,
  });
}

function action(
  surface: ChannelSurface,
  id: string,
  label: string,
  description: string,
  inputSchema?: Record<string, unknown>,
  dangerous = false,
): ChannelOperatorActionDescriptor {
  return {
    id,
    surface,
    label,
    description,
    dangerous,
    ...(inputSchema ? { inputSchema } : {}),
    metadata: { provider: 'homeassistant' },
  };
}

function tool(
  surface: ChannelSurface,
  id: string,
  name: string,
  description: string,
  actionIds: readonly string[],
  inputSchema: Record<string, unknown> = { type: 'object', additionalProperties: false },
): ChannelToolDescriptor {
  return {
    id,
    surface,
    name,
    description,
    actionIds,
    inputSchema,
    metadata: { provider: 'homeassistant' },
  };
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  return Math.max(1, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}
