export const GOODVIBES_CLOUDFLARE_WORKER_MODULE = `
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function optionalJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function resolveDaemonUrl(env) {
  return String(env.GOODVIBES_DAEMON_URL || '').replace(/\\/+$/, '');
}

function toDaemonBatchPath(pathname) {
  if (pathname.startsWith('/api/batch')) return pathname;
  if (pathname.startsWith('/batch/')) return '/api' + pathname;
  if (pathname === '/batch') return '/api/batch';
  return null;
}

function requireWorkerAuth(request, env) {
  const expected = String(env.GOODVIBES_WORKER_TOKEN || '');
  if (!expected) return null;
  const auth = request.headers.get('authorization') || '';
  if (auth === 'Bearer ' + expected) return null;
  return json({ error: 'Worker authorization required', code: 'WORKER_AUTH_REQUIRED' }, 401);
}

async function proxyDaemonJson(env, path, init) {
  const baseUrl = resolveDaemonUrl(env);
  if (!baseUrl) {
    return json({ error: 'GOODVIBES_DAEMON_URL is not configured', code: 'DAEMON_URL_REQUIRED' }, 503);
  }
  const headers = new Headers();
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = String(env.GOODVIBES_OPERATOR_TOKEN || '');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  return fetch(baseUrl + path + (init.search || ''), {
    method: init.method,
    headers,
    body: init.body,
  });
}

async function handleQueuePayload(payload, env) {
  if (payload.type === 'batch.tick') {
    return proxyDaemonJson(env, '/api/batch/tick', {
      method: 'POST',
      body: JSON.stringify({ force: payload.force === true }),
    });
  }
  return proxyDaemonJson(env, '/api/batch/jobs', {
    method: 'POST',
    body: JSON.stringify({
      ...toRecord(payload.body),
      source: {
        kind: 'cloudflare-queue',
        id: typeof payload.body?.id === 'string' ? payload.body.id : undefined,
      },
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/batch/health') {
      return json({ ok: true, service: 'goodvibes-cloudflare-worker' });
    }

    const authError = requireWorkerAuth(request, env);
    if (authError) return authError;

    if (url.pathname === '/batch/tick/enqueue' && request.method === 'POST') {
      const queue = env.GOODVIBES_BATCH_QUEUE;
      if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
      const body = await optionalJson(request);
      await queue.send({
        type: 'batch.tick',
        force: toRecord(body).force === true,
        enqueuedAt: Date.now(),
      });
      return json({ queued: true }, 202);
    }

    const daemonPath = toDaemonBatchPath(url.pathname);
    if (!daemonPath) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

    if (url.pathname === '/batch/jobs/enqueue' && request.method === 'POST') {
      if (String(env.GOODVIBES_QUEUE_JOB_PAYLOADS || '') !== 'true') {
        return json({
          error: 'Queueing full batch job payloads is disabled. Post /batch/jobs to proxy directly to the daemon, or enable queueJobPayloads explicitly.',
          code: 'QUEUE_PAYLOADS_DISABLED',
        }, 409);
      }
      const queue = env.GOODVIBES_BATCH_QUEUE;
      if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
      const body = await optionalJson(request);
      await queue.send({
        type: 'batch.job.create',
        body: toRecord(body),
        enqueuedAt: Date.now(),
      });
      return json({ queued: true }, 202);
    }

    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    return proxyDaemonJson(env, daemonPath, {
      method: request.method,
      body,
      search: url.search,
    });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const response = await handleQueuePayload(message.body, env);
        if (response.ok) {
          message.ack?.();
        } else {
          message.retry?.();
        }
      } catch {
        message.retry?.();
      }
    }
  },

  async scheduled(_event, env) {
    await proxyDaemonJson(env, '/api/batch/tick', {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });
  },
};
`.trim();
