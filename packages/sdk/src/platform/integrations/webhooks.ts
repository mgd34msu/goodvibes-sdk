import { logger } from '../utils/logger.js';
import type { RuntimeEventBus, AgentEvent, WorkflowEvent } from '../runtime/events/index.js';
import { classifyHostTrustTier, extractHostname, emitSsrfDeny } from '../tools/fetch/trust-tiers.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

// ---------------------------------------------------------------------------
// WebhookNotifier
// ---------------------------------------------------------------------------

/**
 * WebhookNotifier — sends HTTP POST notifications to configured webhook URLs.
 *
 * Defaults to ntfy.sh-compatible format: plain text body, no auth required.
 * Works with any service that accepts a plain POST with a text/plain body,
 * including ntfy.sh, generic webhooks, and custom endpoints.
 *
 * Usage:
 *   const notifier = new WebhookNotifier(['https://ntfy.sh/my-topic']);
 *   notifier.attachToRuntimeBus(runtimeBus);
 */
export class WebhookNotifier {
  private urls: string[];
  private unsubscribers: Array<() => void> = [];
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxBodyBytes: number;
  private readonly signingSecret?: string | Uint8Array | undefined;

  constructor(urls: string[] = [], options: WebhookNotifierOptions = {}) {
    this.urls = validateWebhookUrls(urls);
    this.timeoutMs = normalizeWebhookTimeoutMs(options.timeoutMs);
    this.maxConcurrent = normalizePositiveInteger(options.maxConcurrent, 8, 1, 32);
    this.maxBodyBytes = normalizePositiveInteger(options.maxBodyBytes, 64 * 1024, 1_024, 256 * 1024);
    this.signingSecret = normalizeSigningSecret(options.signingSecret);
  }

  /**
   * Create a WebhookNotifier from a list of URLs (e.g. from persisted config).
   */
  static fromConfig(urls: string[]): WebhookNotifier {
    return new WebhookNotifier(urls);
  }

  // -------------------------------------------------------------------------
  // URL management
  // -------------------------------------------------------------------------

  /** Add a webhook URL. Ignores duplicates. Throws on invalid URL. */
  addUrl(url: string): void {
    new URL(url); // throws TypeError if url is invalid
    if (!this.urls.includes(url)) {
      this.urls.push(url);
      logger.info('WebhookNotifier: added URL', { url });
    }
  }

  /** Remove a webhook URL. */
  removeUrl(url: string): boolean {
    const before = this.urls.length;
    this.urls = this.urls.filter((u) => u !== url);
    const removed = this.urls.length < before;
    if (removed) logger.info('WebhookNotifier: removed URL', { url });
    return removed;
  }

  /** Replace all webhook URLs. */
  setUrls(urls: string[]): void {
    this.urls = validateWebhookUrls(urls);
  }

  /** Get a copy of all configured webhook URLs. */
  getUrls(): string[] {
    return [...this.urls];
  }

  /** Returns true if at least one URL is configured. */
  isConfigured(): boolean {
    return this.urls.length > 0;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a plain-text notification to all configured webhooks.
   *
   * Uses ntfy.sh format by default: POST with text/plain body.
   * URLs are delivered with bounded concurrency; individual failures are
   * logged but do not throw — remaining URLs still receive the notification.
   */
  async send(text: string): Promise<void> {
    if (this.urls.length === 0) return;

    const results = await mapSettledWithConcurrency(this.urls, this.maxConcurrent, (url) => this.postOne(url, text));

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn('WebhookNotifier: delivery failed', { url: this.urls[i], error: msg });
      }
    }
  }

  /**
   * Send a test notification to all configured webhooks.
   */
  async test(): Promise<{ url: string; ok: boolean; error?: string }[]> {
    if (this.urls.length === 0) return [];

    const results = await mapSettledWithConcurrency(this.urls, this.maxConcurrent, (url) => this.postOne(url, 'goodvibes-sdk: webhook test'));

    return this.urls.map((url, i) => {
      const result = results[i]!;
      if (result.status === 'fulfilled') {
        return { url, ok: true };
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return { url, ok: false, error };
      }
    });
  }

  // -------------------------------------------------------------------------
  // Runtime event integration
  // -------------------------------------------------------------------------

  attachToRuntimeBus(bus: RuntimeEventBus): void {
    this.detach();

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
        this.sendRuntimeNotification(`Agent completed: ${payload.agentId}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
        this.sendRuntimeNotification(`Agent failed: ${payload.agentId} — ${payload.error}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
        this.sendRuntimeNotification(`WRFC passed: chain ${payload.chainId}`);
      }),
    );

    this.unsubscribers.push(
      bus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
        this.sendRuntimeNotification(`WRFC failed: ${payload.reason}`);
      }),
    );

    logger.info('WebhookNotifier: attached to RuntimeEventBus', { urlCount: this.urls.length });
  }

  /** Remove all webhook subscriptions. */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async postOne(url: string, text: string): Promise<void> {
    // SEC-08: SSRF tier filter — block requests to internal/private hosts.
    const hostname = extractHostname(url);
    if (hostname !== null) {
      const trustResult = classifyHostTrustTier(hostname);
      if (trustResult.tier === 'blocked') {
        emitSsrfDeny(hostname, url, trustResult.reason);
        throw new Error(`WebhookNotifier: blocked URL — ${trustResult.reason}`);
      }
    }

    const signal = createTimeoutSignal(this.timeoutMs);
    try {
      const body = truncateUtf8(text, this.maxBodyBytes);
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (this.signingSecret) {
        Object.assign(headers, await createWebhookSignatureHeaders(body, this.signingSecret));
      }
      const res = await instrumentedFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: signal.signal,
      });
      if (!res.ok) {
        let responseText = '';
        try {
          responseText = await res.text();
        } catch (error) {
          logger.warn('WebhookNotifier: failed to read non-2xx response body', {
            url,
            status: res.status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw new Error(`HTTP ${res.status}: ${truncateUtf8(responseText, 4_096)}`);
      }
    } finally {
      signal.dispose();
    }
  }

  private sendRuntimeNotification(text: string): void {
    void this.send(text).catch((error) => {
      logger.warn('WebhookNotifier: runtime event notification dispatch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export interface WebhookNotifierOptions {
  timeoutMs?: number | undefined;
  maxConcurrent?: number | undefined;
  maxBodyBytes?: number | undefined;
  signingSecret?: string | Uint8Array | undefined;
}

function normalizeWebhookTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return 10_000;
  }
  return Math.min(60_000, Math.max(1_000, Math.trunc(timeoutMs)));
}

function normalizePositiveInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateWebhookUrls(urls: readonly string[]): string[] {
  return urls.map((url) => {
    new URL(url);
    return url;
  });
}

function normalizeSigningSecret(secret: string | Uint8Array | undefined): string | Uint8Array | undefined {
  if (typeof secret === 'string') return secret.trim().length > 0 ? secret : undefined;
  if (secret instanceof Uint8Array) return secret.byteLength > 0 ? secret : undefined;
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const next = encoder.encode(char).byteLength;
    if (bytes + next > maxBytes) break;
    out += char;
    bytes += next;
  }
  return out;
}

function createTimeoutSignal(timeoutMs: number): { readonly signal: AbortSignal; dispose: () => void } {
  if (typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

async function createWebhookSignatureHeaders(
  body: string,
  secret: string | Uint8Array,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encoder = new TextEncoder();
  const keyBytes = typeof secret === 'string'
    ? encoder.encode(secret)
    : new Uint8Array(secret);
  const rawKey = new Uint8Array(keyBytes).buffer;
  if (!globalThis.crypto?.subtle) {
    throw new Error('Webhook signing requires Web Crypto HMAC support.');
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = encoder.encode(`${timestamp}.${body}`);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, payload);
  return {
    'X-GoodVibes-Webhook-Timestamp': timestamp,
    'X-GoodVibes-Webhook-Signature': `v1=${hex(new Uint8Array(signature))}`,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function mapSettledWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await worker(values[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
