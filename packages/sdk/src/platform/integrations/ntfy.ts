/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */
import { request as httpRequest } from 'node:http';
import { connect as http2Connect } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

export const GOODVIBES_NTFY_ORIGIN = 'goodvibes-sdk';
export const GOODVIBES_NTFY_ORIGIN_HEADER = 'X-Goodvibes-Origin';
export const GOODVIBES_NTFY_OUTBOUND_TAG = 'goodvibes-sdk-outbound';
export const GOODVIBES_NTFY_CHAT_TOPIC = 'goodvibes-chat';
export const GOODVIBES_NTFY_AGENT_TOPIC = 'goodvibes-agent';
export const GOODVIBES_NTFY_REMOTE_TOPIC = 'goodvibes-ntfy';
export const GOODVIBES_NTFY_DEFAULT_TOPICS = [
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_REMOTE_TOPIC,
] as const;

export interface GoodVibesNtfyTopicConfig {
  readonly chatTopic?: string | null;
  readonly agentTopic?: string | null;
  readonly remoteTopic?: string | null;
}

export interface GoodVibesNtfyTopics {
  readonly chatTopic: string;
  readonly agentTopic: string;
  readonly remoteTopic: string;
  readonly all: readonly string[];
}

export function resolveGoodVibesNtfyTopics(config: GoodVibesNtfyTopicConfig = {}): GoodVibesNtfyTopics {
  const chatTopic = normalizeNtfyTopic(config.chatTopic, GOODVIBES_NTFY_CHAT_TOPIC);
  const agentTopic = normalizeNtfyTopic(config.agentTopic, GOODVIBES_NTFY_AGENT_TOPIC);
  const remoteTopic = normalizeNtfyTopic(config.remoteTopic, GOODVIBES_NTFY_REMOTE_TOPIC);
  return {
    chatTopic,
    agentTopic,
    remoteTopic,
    all: [...new Set([chatTopic, agentTopic, remoteTopic])],
  };
}

export function createNtfyLiveSubscriptionSince(nowMs = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

export interface NtfyPublishOptions {
  readonly title?: string;
  readonly priority?: 1 | 2 | 3 | 4 | 5;
  readonly tags?: readonly string[];
  readonly click?: string;
  readonly attach?: string;
  readonly actions?: readonly string[];
  readonly markGoodVibesOrigin?: boolean;
}

export interface NtfyMessage {
  readonly id?: string;
  readonly time?: number;
  readonly event: 'open' | 'keepalive' | 'message' | 'message_delete' | 'message_clear' | 'poll_request' | string;
  readonly topic?: string;
  readonly message?: string;
  readonly title?: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
  readonly click?: string;
  readonly actions?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface NtfySubscribeOptions {
  readonly since?: string;
  readonly scheduled?: boolean;
  readonly poll?: boolean;
  readonly filters?: Record<string, string | number | boolean | readonly string[]>;
  readonly signal?: AbortSignal;
  readonly reconnect?: boolean;
  readonly reconnectDelayMs?: number;
}

export interface NtfyWebSocketOptions extends NtfySubscribeOptions {
  readonly WebSocketImpl?: typeof WebSocket;
}

export class NtfyIntegration {
  constructor(
    private readonly baseUrl = 'https://ntfy.sh',
    private readonly token?: string,
  ) {}

  async publish(topic: string, message: string, options: NtfyPublishOptions = {}): Promise<void> {
    const target = `${this.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    const headers = new Headers({
      'Content-Type': 'text/plain; charset=utf-8',
    });
    if (options.title) headers.set('Title', options.title);
    if (options.priority) headers.set('Priority', String(options.priority));
    const tags = options.markGoodVibesOrigin
      ? [...new Set([...(options.tags ?? []), GOODVIBES_NTFY_OUTBOUND_TAG])]
      : options.tags ?? [];
    if (tags.length) headers.set('Tags', tags.join(','));
    if (options.click) headers.set('Click', options.click);
    if (options.attach) headers.set('Attach', options.attach);
    if (options.actions?.length) headers.set('Actions', options.actions.join(';'));
    if (options.markGoodVibesOrigin) headers.set(GOODVIBES_NTFY_ORIGIN_HEADER, GOODVIBES_NTFY_ORIGIN);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    const response = await fetchWithTimeout(target, {
      method: 'POST',
      headers,
      body: message,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`NtfyIntegration.publish failed (${response.status}): ${body}`);
    }
  }

  buildSubscribeUrl(topic: string, mode: 'json' | 'sse' | 'raw' | 'ws' = 'json', options: NtfySubscribeOptions = {}): string {
    const pathTopic = topic.split(',').map((entry) => encodeURIComponent(entry.trim())).filter(Boolean).join(',');
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/${pathTopic}/${mode}`);
    if (options.poll) url.searchParams.set('poll', '1');
    if (options.since) url.searchParams.set('since', options.since);
    if (options.scheduled) url.searchParams.set('scheduled', '1');
    for (const [key, value] of Object.entries(options.filters ?? {})) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    if (mode === 'ws') {
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    }
    return url.toString();
  }

  async poll(topic: string, options: Omit<NtfySubscribeOptions, 'poll'> = {}): Promise<NtfyMessage[]> {
    const url = this.buildSubscribeUrl(topic, 'json', { ...options, poll: true });
    const headers = this.buildAuthHeaders();
    const response = await instrumentedFetch(url, {
      method: 'GET',
      headers,
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`NtfyIntegration.poll failed (${response.status}): ${body}`);
    }
    const raw = await response.text();
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NtfyMessage);
  }

  async subscribeJsonStream(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfySubscribeOptions = {},
  ): Promise<void> {
    const reconnect = options.reconnect ?? !options.poll;
    let resumeSince = options.since;
    const seenMessageIds = new NtfySeenMessageIds();
    while (!options.signal?.aborted) {
      const url = this.buildSubscribeUrl(topic, 'json', { ...options, since: resumeSince });
      try {
        await readNtfyJsonStreamWithNodeTransport(url, this.buildAuthHeaders(), async (message) => {
          const messageId = readNtfyMessageId(message);
          if (messageId && seenMessageIds.has(messageId)) return;
          await onMessage(message);
          if (messageId) {
            seenMessageIds.add(messageId);
            resumeSince = messageId;
          } else if (message.event === 'message' && typeof message.time === 'number' && Number.isFinite(message.time)) {
            resumeSince = String(Math.floor(message.time));
          }
        }, options.signal);
      } catch (error) {
        if (options.signal?.aborted) return;
        if (!reconnect || isFatalNtfyStreamError(error)) throw error;
      }
      if (!reconnect || options.signal?.aborted) return;
      await waitForNtfyReconnectDelay(options.signal, options.reconnectDelayMs ?? 1_000);
    }
  }

  connectWebSocket(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfyWebSocketOptions = {},
  ): WebSocket {
    const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    const socket = new WebSocketImpl(this.buildSubscribeUrl(topic, 'ws', options));
    socket.addEventListener('message', (event) => {
      void (async () => {
        const raw = typeof event.data === 'string'
          ? event.data
          : event.data instanceof Buffer
            ? event.data.toString('utf-8')
            : String(event.data);
        if (!raw.trim()) return;
        await onMessage(JSON.parse(raw) as NtfyMessage);
      })().catch((error: unknown) => {
        logger.warn('[ntfy] websocket message handling failed', { error: summarizeError(error) });
      });
    });
    return socket;
  }

  private buildAuthHeaders(): Headers {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }
}

class NtfySeenMessageIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length <= 1_024) return;
    const expired = this.order.shift();
    if (expired) this.ids.delete(expired);
  }
}

function readNtfyMessageId(message: NtfyMessage): string | null {
  return message.event === 'message' && typeof message.id === 'string' && message.id.trim()
    ? message.id
    : null;
}

export function isGoodVibesNtfyDeliveryEcho(message: Record<string, unknown>): boolean {
  if (message.event !== 'message') return false;
  const tags = message.tags;
  if (Array.isArray(tags) && tags.includes(GOODVIBES_NTFY_OUTBOUND_TAG)) return true;
  const headers = readRecord(message.headers);
  const originHeader = headers ? readCaseInsensitiveHeader(headers, GOODVIBES_NTFY_ORIGIN_HEADER) : undefined;
  return originHeader === GOODVIBES_NTFY_ORIGIN;
}

function normalizeNtfyTopic(value: string | null | undefined, fallback: string): string {
  const topic = typeof value === 'string' ? value.trim() : '';
  return topic || fallback;
}

class NtfyStreamHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`NtfyIntegration.subscribeJsonStream failed (${status}): ${body}`);
    this.name = 'NtfyStreamHttpError';
  }
}

interface NtfyJsonStreamState {
  buffer: string;
  queue: Promise<void>;
}

async function readNtfyJsonStreamWithNodeTransport(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    return readNtfyJsonStreamWithHttp1(url, headers, onMessage, signal, httpRequest);
  }
  if (parsed.protocol === 'https:') {
    try {
      await readNtfyJsonStreamWithHttp2(url, headers, onMessage, signal);
      return;
    } catch (error) {
      if (signal?.aborted || error instanceof NtfyStreamHttpError) throw error;
      return readNtfyJsonStreamWithHttp1(url, headers, onMessage, signal, httpsRequest);
    }
  }
  throw new Error(`Unsupported ntfy stream protocol: ${parsed.protocol}`);
}

function readNtfyJsonStreamWithHttp1(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal: AbortSignal | undefined,
  requestImpl: typeof httpRequest,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const state: NtfyJsonStreamState = { buffer: '', queue: Promise.resolve() };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const finish = () => settle(resolve);
    const finishQueuedJson = () => {
      state.queue
        .then(() => flushNtfyJsonBuffer(state, onMessage))
        .then(finish)
        .catch(fail);
    };
    const abort = () => {
      aborted = true;
      req.destroy();
      finish();
    };
    const req = requestImpl(url, {
      method: 'GET',
      headers: headersToRecord(headers),
    }, (res) => {
      res.setEncoding('utf8');
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        let body = '';
        res.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => fail(new NtfyStreamHttpError(status, body)));
        res.on('error', fail);
        return;
      }
      res.on('data', (chunk: string) => {
        state.queue = state.queue
          .then(() => consumeNtfyJsonChunk(state, chunk, onMessage))
          .catch(fail);
      });
      res.on('end', () => {
        finishQueuedJson();
      });
      res.on('error', (error) => {
        if (aborted) finish();
        else fail(error);
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    req.end();
  });
}

function readNtfyJsonStreamWithHttp2(
  url: string,
  headers: Headers,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = http2Connect(parsed.origin);
    const path = `${parsed.pathname}${parsed.search}`;
    const state: NtfyJsonStreamState = { buffer: '', queue: Promise.resolve() };
    let settled = false;
    let aborted = false;
    let status = 0;
    let errorBody = '';
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.close();
      callback();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const finish = () => settle(resolve);
    const finishQueuedJson = () => {
      state.queue
        .then(() => flushNtfyJsonBuffer(state, onMessage))
        .then(finish)
        .catch(fail);
    };
    const abort = () => {
      aborted = true;
      stream.close();
      finish();
    };
    const stream = client.request({
      ':method': 'GET',
      ':path': path,
      ...headersToRecord(headers),
    });
    signal?.addEventListener('abort', abort, { once: true });
    stream.setEncoding('utf8');
    stream.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status'] ?? 0);
    });
    stream.on('data', (chunk: string) => {
      if (status !== 0 && (status < 200 || status >= 300)) {
        if (errorBody.length < 4096) errorBody += chunk;
        return;
      }
      state.queue = state.queue
        .then(() => consumeNtfyJsonChunk(state, chunk, onMessage))
        .catch(fail);
    });
    stream.on('end', () => {
      if (status < 200 || status >= 300) {
        fail(new NtfyStreamHttpError(status, errorBody));
        return;
      }
      finishQueuedJson();
    });
    stream.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    client.on('error', (error) => {
      if (aborted) finish();
      else fail(error);
    });
    stream.end();
  });
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

async function consumeNtfyJsonChunk(
  state: NtfyJsonStreamState,
  chunk: string,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
): Promise<void> {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    await onMessage(JSON.parse(trimmed) as NtfyMessage);
  }
}

async function flushNtfyJsonBuffer(
  state: NtfyJsonStreamState,
  onMessage: (message: NtfyMessage) => void | Promise<void>,
): Promise<void> {
  const trimmed = state.buffer.trim();
  state.buffer = '';
  if (trimmed) await onMessage(JSON.parse(trimmed) as NtfyMessage);
}

function isFatalNtfyStreamError(error: unknown): boolean {
  return error instanceof NtfyStreamHttpError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
}

function waitForNtfyReconnectDelay(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (signal?.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => done();
    timeout = setTimeout(done, delayMs);
    timeout.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCaseInsensitiveHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}
