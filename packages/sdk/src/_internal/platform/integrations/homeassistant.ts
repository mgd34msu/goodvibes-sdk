import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

const DEFAULT_HOME_ASSISTANT_TIMEOUT_MS = 15_000;
const DEFAULT_HOME_ASSISTANT_RESPONSE_BYTES = 2_000_000;

export interface HomeAssistantStateRecord {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes?: Record<string, unknown>;
  readonly last_changed?: string;
  readonly last_updated?: string;
  readonly context?: Record<string, unknown>;
}

export interface HomeAssistantServiceRecord {
  readonly domain: string;
  readonly services: Record<string, unknown> | readonly string[];
}

export interface HomeAssistantClientOptions {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface HomeAssistantGoodVibesEvent {
  readonly type: string;
  readonly title?: string;
  readonly body: string;
  readonly speechText?: string;
  readonly status?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceId?: string;
  readonly externalId?: string;
  readonly messageId?: string;
  readonly replyToMessageId?: string;
  readonly conversationId?: string;
  readonly metadata?: Record<string, unknown>;
}

export class HomeAssistantIntegration {
  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HomeAssistantClientOptions) {
    this.baseUrl = normalizeHomeAssistantBaseUrl(options.baseUrl);
    this.accessToken = options.accessToken?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HOME_ASSISTANT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_HOME_ASSISTANT_RESPONSE_BYTES;
  }

  async getApiStatus(): Promise<unknown> {
    return this.requestJson('/api/', { auth: Boolean(this.accessToken) });
  }

  async getConfig(): Promise<unknown> {
    return this.requestJson('/api/config', { auth: true });
  }

  async listStates(): Promise<HomeAssistantStateRecord[]> {
    const payload = await this.requestJson('/api/states', { auth: true });
    return Array.isArray(payload) ? payload.filter(isHomeAssistantState) : [];
  }

  async getState(entityId: string): Promise<HomeAssistantStateRecord | null> {
    const payload = await this.requestJson(`/api/states/${encodeURIComponent(entityId)}`, {
      auth: true,
      notFoundAsNull: true,
    });
    return isHomeAssistantState(payload) ? payload : null;
  }

  async listServices(): Promise<HomeAssistantServiceRecord[]> {
    const payload = await this.requestJson('/api/services', { auth: true });
    return Array.isArray(payload) ? payload.filter(isHomeAssistantService) : [];
  }

  async callService(input: {
    readonly domain: string;
    readonly service: string;
    readonly serviceData?: Record<string, unknown>;
    readonly returnResponse?: boolean;
  }): Promise<unknown> {
    const path = `/api/services/${encodeURIComponent(input.domain)}/${encodeURIComponent(input.service)}`
      + (input.returnResponse ? '?return_response' : '');
    return this.requestJson(path, {
      auth: true,
      method: 'POST',
      body: input.serviceData ?? {},
    });
  }

  async fireEvent(eventType: string, eventData: Record<string, unknown> = {}): Promise<unknown> {
    return this.requestJson(`/api/events/${encodeURIComponent(eventType)}`, {
      auth: true,
      method: 'POST',
      body: eventData,
    });
  }

  async renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    const payload = await this.requestText('/api/template', {
      auth: true,
      method: 'POST',
      body: {
        template,
        ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
      },
    });
    return payload;
  }

  async publishGoodVibesEvent(eventType: string, event: HomeAssistantGoodVibesEvent): Promise<unknown> {
    return this.fireEvent(eventType, {
      ...event,
      source: 'goodvibes',
      emittedAt: new Date().toISOString(),
    });
  }

  private async requestJson(
    path: string,
    options: {
      readonly auth?: boolean;
      readonly method?: string;
      readonly body?: Record<string, unknown>;
      readonly notFoundAsNull?: boolean;
    } = {},
  ): Promise<unknown> {
    const response = await this.request(path, options);
    if (options.notFoundAsNull && response.status === 404) return null;
    const text = await readResponseTextWithinLimit(response, this.maxResponseBytes);
    if (!response.ok) {
      throw new Error(`Home Assistant HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async requestText(
    path: string,
    options: {
      readonly auth?: boolean;
      readonly method?: string;
      readonly body?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const response = await this.request(path, options);
    const text = await readResponseTextWithinLimit(response, this.maxResponseBytes);
    if (!response.ok) {
      throw new Error(`Home Assistant HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
    }
    return text;
  }

  private async request(
    path: string,
    options: {
      readonly auth?: boolean;
      readonly method?: string;
      readonly body?: Record<string, unknown>;
    },
  ): Promise<Response> {
    if (options.auth && !this.accessToken) {
      throw new Error('Home Assistant access token is not configured.');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.auth && this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
    };
    return instrumentedFetch(new URL(path, `${this.baseUrl}/`).toString(), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export function normalizeHomeAssistantBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Home Assistant base URL is required.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Home Assistant base URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Home Assistant base URL must use http or https.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function isHomeAssistantState(value: unknown): value is HomeAssistantStateRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.entity_id === 'string' && typeof record.state === 'string';
}

function isHomeAssistantService(value: unknown): value is HomeAssistantServiceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.domain === 'string'
    && (Array.isArray(record.services) || (typeof record.services === 'object' && record.services !== null));
}

async function readResponseTextWithinLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Home Assistant response too large: ${contentLength} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Response too large').catch(() => undefined);
        throw new Error(`Home Assistant response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
