import { describe, expect, test } from 'bun:test';
import {
  createGoodVibesCloudflareWorker,
  type GoodVibesCloudflareQueuePayload,
} from '../packages/sdk/src/workers.js';

describe('Cloudflare Worker batch bridge', () => {
  test('proxies batch job creation directly to the daemon by default', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return Response.json({ job: { id: 'batch-job-1' } }, { status: 202 });
    }) as typeof fetch;
    try {
      const worker = createGoodVibesCloudflareWorker();
      const res = await worker.fetch(
        new Request('https://worker.example/batch/jobs', {
          method: 'POST',
          body: JSON.stringify({ request: { messages: [{ role: 'user', content: 'hi' }] } }),
        }),
        { GOODVIBES_DAEMON_URL: 'https://daemon.example', GOODVIBES_OPERATOR_TOKEN: 'token' },
        { waitUntil: () => undefined },
      );
      expect(res.status).toBe(202);
      expect(calls[0]?.url).toBe('https://daemon.example/api/batch/jobs');
      expect(calls[0]?.init?.method).toBe('POST');
      const headers = calls[0]?.init?.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('queues tick signals without queueing prompt payloads', async () => {
    const messages: GoodVibesCloudflareQueuePayload[] = [];
    const worker = createGoodVibesCloudflareWorker();
    const res = await worker.fetch(
      new Request('https://worker.example/batch/tick/enqueue', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      }),
      {
        GOODVIBES_BATCH_QUEUE: {
          async send(message) {
            messages.push(message);
          },
        },
      },
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(202);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe('batch.tick');
    expect(messages[0]?.force).toBe(true);
    expect(typeof messages[0]?.enqueuedAt).toBe('number');
  });
});
