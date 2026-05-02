export interface GoodVibesCloudflareQueue<Body = unknown> {
  send(message: Body): Promise<void>;
}

export interface GoodVibesCloudflareQueueMessage<Body = unknown> {
  readonly body: Body;
  ack?(): void;
  retry?(): void;
}

export interface GoodVibesCloudflareMessageBatch<Body = unknown> {
  readonly messages: readonly GoodVibesCloudflareQueueMessage<Body>[];
}

export interface GoodVibesCloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface GoodVibesCloudflareWorkerEnv {
  GOODVIBES_DAEMON_URL?: string;
  GOODVIBES_OPERATOR_TOKEN?: string;
  GOODVIBES_WORKER_TOKEN?: string;
  GOODVIBES_QUEUE_JOB_PAYLOADS?: string;
  GOODVIBES_BATCH_QUEUE?: GoodVibesCloudflareQueue<GoodVibesCloudflareQueuePayload>;
}

export type GoodVibesCloudflareQueuePayload =
  | {
      readonly type: 'batch.tick';
      readonly force?: boolean;
      readonly enqueuedAt?: number;
    }
  | {
      readonly type: 'batch.job.create';
      readonly body: Record<string, unknown>;
      readonly enqueuedAt?: number;
    };

export interface GoodVibesCloudflareWorkerOptions {
  readonly daemonUrl?: string;
  readonly authToken?: string;
  readonly workerAuthToken?: string;
  readonly queueJobPayloads?: boolean;
  /**
   * Explicitly allow unauthenticated non-health endpoints.
   * Default is false: GOODVIBES_WORKER_TOKEN or workerAuthToken is required.
   */
  readonly allowUnauthenticated?: boolean;
  readonly maxRequestBodyBytes?: number;
}

export interface GoodVibesCloudflareWorker {
  fetch(request: Request, env: GoodVibesCloudflareWorkerEnv, ctx: GoodVibesCloudflareExecutionContext): Promise<Response>;
  queue(batch: GoodVibesCloudflareMessageBatch<GoodVibesCloudflareQueuePayload>, env: GoodVibesCloudflareWorkerEnv, ctx: GoodVibesCloudflareExecutionContext): Promise<void>;
  scheduled(event: unknown, env: GoodVibesCloudflareWorkerEnv, ctx: GoodVibesCloudflareExecutionContext): Promise<void>;
}

export function createGoodVibesCloudflareWorker(
  options: GoodVibesCloudflareWorkerOptions = {},
): GoodVibesCloudflareWorker {
  return {
    async fetch(request, env, _ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/health' || url.pathname === '/batch/health') {
        return json({ ok: true, service: 'goodvibes-cloudflare-worker' });
      }

      const authError = requireWorkerAuth(request, env, options);
      if (authError) return authError;

      if (url.pathname === '/batch/tick/enqueue' && request.method === 'POST') {
        const queue = env.GOODVIBES_BATCH_QUEUE;
        if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
        const body = await optionalJson(request);
        if (body instanceof Response) return body;
        await queue.send({
          type: 'batch.tick',
          force: toRecord(body)['force'] === true,
          enqueuedAt: Date.now(),
        });
        return json({ queued: true }, 202);
      }

      const daemonPath = toDaemonBatchPath(url.pathname);
      if (!daemonPath) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

      if (url.pathname === '/batch/jobs/enqueue' && request.method === 'POST') {
        if (!options.queueJobPayloads && env.GOODVIBES_QUEUE_JOB_PAYLOADS !== 'true') {
          return json({
            error: 'Queueing full batch job payloads is disabled. Post /batch/jobs to proxy directly to the daemon, or enable queueJobPayloads explicitly.',
            code: 'QUEUE_PAYLOADS_DISABLED',
          }, 409);
        }
        const queue = env.GOODVIBES_BATCH_QUEUE;
        if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
        const body = await optionalJson(request);
        if (body instanceof Response) return body;
        await queue.send({
          type: 'batch.job.create',
          body: toRecord(body),
          enqueuedAt: Date.now(),
        });
        return json({ queued: true }, 202);
      }

      return proxyDaemonBatch(request, env, options, daemonPath);
    },
    async queue(batch, env, _ctx) {
      for (const message of batch.messages) {
        try {
          const response = await handleQueuePayload(message.body, env, options);
          if (response.ok) {
            message.ack?.();
          } else {
            message.retry?.();
          }
        } catch (error) {
          console.warn('GoodVibes worker queue message failed', { error });
          message.retry?.();
        }
      }
    },
    async scheduled(_event, env) {
      await proxyDaemonJson(env, options, '/api/batch/tick', {
        method: 'POST',
        body: JSON.stringify({ force: false }),
      });
    },
  };
}

async function handleQueuePayload(
  payload: GoodVibesCloudflareQueuePayload,
  env: GoodVibesCloudflareWorkerEnv,
  options: GoodVibesCloudflareWorkerOptions,
): Promise<Response> {
  if (payload.type === 'batch.tick') {
    return proxyDaemonJson(env, options, '/api/batch/tick', {
      method: 'POST',
      body: JSON.stringify({ force: payload.force === true }),
    });
  }
  return proxyDaemonJson(env, options, '/api/batch/jobs', {
    method: 'POST',
    body: JSON.stringify({
      ...payload.body,
      source: {
        kind: 'cloudflare-queue',
        id: typeof payload.body['id'] === 'string' ? payload.body['id'] : undefined,
      },
    }),
  });
}

async function proxyDaemonBatch(
  request: Request,
  env: GoodVibesCloudflareWorkerEnv,
  options: GoodVibesCloudflareWorkerOptions,
  daemonPath: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Only application/json batch payloads are supported', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    }
  }
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await readTextBodyWithinLimit(request, options.maxRequestBodyBytes);
  if (body instanceof Response) return body;
  return proxyDaemonJson(env, options, daemonPath, {
    method: request.method,
    body,
    search: new URL(request.url).search,
  });
}

async function proxyDaemonJson(
  env: GoodVibesCloudflareWorkerEnv,
  options: GoodVibesCloudflareWorkerOptions,
  path: string,
  init: { readonly method: string; readonly body?: string; readonly search?: string },
): Promise<Response> {
  const baseUrl = resolveDaemonUrl(env, options);
  if (!baseUrl) {
    return json({ error: 'GOODVIBES_DAEMON_URL is not configured', code: 'DAEMON_URL_REQUIRED' }, 503);
  }
  const headers = new Headers();
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = options.authToken ?? env.GOODVIBES_OPERATOR_TOKEN ?? '';
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${baseUrl}${path}${init.search ?? ''}`, {
    method: init.method,
    headers,
    body: init.body,
  });
}

function toDaemonBatchPath(pathname: string): string | null {
  if (pathname.startsWith('/api/batch')) return pathname;
  if (pathname.startsWith('/batch/')) return `/api${pathname}`;
  if (pathname === '/batch') return '/api/batch';
  return null;
}

function requireWorkerAuth(
  request: Request,
  env: GoodVibesCloudflareWorkerEnv,
  options: GoodVibesCloudflareWorkerOptions,
): Response | null {
  const expected = options.workerAuthToken ?? env.GOODVIBES_WORKER_TOKEN ?? '';
  if (!expected && options.allowUnauthenticated === true) return null;
  if (!expected) {
    return json({
      error: 'GOODVIBES_WORKER_TOKEN is required for non-health endpoints',
      code: 'WORKER_AUTH_TOKEN_REQUIRED',
    }, 503);
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth === `Bearer ${expected}`) return null;
  return json({ error: 'Worker authorization required', code: 'WORKER_AUTH_REQUIRED' }, 401);
}

function resolveDaemonUrl(
  env: GoodVibesCloudflareWorkerEnv,
  options: GoodVibesCloudflareWorkerOptions,
): string {
  const raw = options.daemonUrl ?? env.GOODVIBES_DAEMON_URL ?? '';
  return raw.replace(/\/+$/, '');
}

async function optionalJson(request: Request): Promise<unknown | Response> {
  const text = await readTextBodyWithinLimit(request);
  if (text instanceof Response) return text;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

async function readTextBodyWithinLimit(
  request: Request,
  maxBytes = 1_000_000,
): Promise<string | Response> {
  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel('Payload too large');
        } catch (error) {
          console.warn('GoodVibes Worker request body cancel failed after size limit', error);
        }
        return json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' }, 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
