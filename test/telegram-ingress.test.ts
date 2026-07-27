/**
 * telegram-ingress.test.ts — inbound Telegram actually works.
 *
 * Background this pins down: registering `POST /webhook/telegram` does not give
 * a daemon inbound Telegram. Telegram pushes nothing until told a webhook URL
 * exists, and delivers nothing until asked via getUpdates. With neither call
 * wired up, a configured bot token produced a surface that could send but never
 * receive — which looked half-working rather than broken.
 *
 * These tests drive the supervisor through an injected fetch, so they assert
 * the real decisions (which Bot API methods get called, in what order, and what
 * happens on 409/401) without touching the network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramIngressSupervisor, describeWebhookUrlProblem } from '../packages/sdk/src/platform/channels/telegram/ingress.ts';
import { TelegramBotApi } from '../packages/sdk/src/platform/channels/telegram/api.ts';
import { TelegramOffsetStore } from '../packages/sdk/src/platform/channels/telegram/offset-store.ts';

// ── fakes ───────────────────────────────────────────────────────────────────

interface ApiCall { readonly method: string; readonly body: Record<string, unknown>; }

/** Queued Bot API responses; once drained, getUpdates long-polls until aborted. */
class FakeTelegram {
  readonly calls: ApiCall[] = [];
  private readonly queues = new Map<string, Array<() => Response>>();

  queue(method: string, ...responses: Array<() => Response>): void {
    const existing = this.queues.get(method) ?? [];
    this.queues.set(method, [...existing, ...responses]);
  }

  countOf(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split('/').pop() ?? '';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, body });

    const next = this.queues.get(method)?.shift();
    if (next) return next();

    if (method === 'getUpdates') {
      // Model Telegram's hold-open long poll: never resolve on its own, so the
      // loop cannot spin, and reject when the supervisor aborts on shutdown.
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return ok(true);
  };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

function apiError(code: number, description: string, retryAfter?: number): Response {
  return new Response(JSON.stringify({
    ok: false,
    error_code: code,
    description,
    ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
  }), { status: code });
}

function textUpdate(updateId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: { chat: { id: 4242, type: 'private' }, from: { id: 7, username: 'mike' }, text },
  };
}

interface Harness {
  readonly supervisor: TelegramIngressSupervisor;
  readonly telegram: FakeTelegram;
  readonly spawned: string[];
  /** Every reason handed to onConcurrentConsumerConflict, in order. */
  readonly conflicts: string[];
  readonly offsetPath: string;
  /** Live settings, so a test can change config and re-decide the mode. */
  readonly config: Record<string, unknown>;
  cleanup(): void;
}

function makeHarness(options: {
  readonly config?: Record<string, unknown>;
  readonly secrets?: Record<string, string>;
  readonly registrySecret?: string | null;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gv-tg-'));
  const offsetPath = join(dir, 'telegram-offset.json');
  const telegram = new FakeTelegram();
  const spawned: string[] = [];
  const conflicts: string[] = [];

  const config: Record<string, unknown> = {
    'surfaces.telegram.enabled': true,
    'surfaces.telegram.mode': 'polling',
    'surfaces.telegram.botToken': '123456:test-token',
    'surfaces.telegram.botUsername': 'goodvibes_bot',
    'web.publicBaseUrl': 'https://daemon.example.com',
    ...options.config,
  };

  const supervisor = new TelegramIngressSupervisor({
    configManager: { get: (key: string) => config[key] } as never,
    secretsManager: {
      get: (key: string) => options.secrets?.[key] ?? null,
      getGlobalHome: () => undefined,
    } as never,
    serviceRegistry: { resolveSecret: async () => options.registrySecret ?? null } as never,
    offsetFilePath: offsetPath,
    createApi: (token) => new TelegramBotApi(token, telegram.fetch),
    onConcurrentConsumerConflict: (detail) => { conflicts.push(detail); },
    buildSurfaceAdapterContext: () => ({
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: (key: string) => config[key] },
      routeBindings: { upsertBinding: async () => ({ id: 'binding-1', surfaceId: 'goodvibes_bot', externalId: '4242', channelId: '4242', threadId: undefined, title: 'Mike' }) },
      sessionBroker: {
        submitMessage: async () => ({ mode: 'spawn', task: { prompt: 'x' }, session: { id: 'session-1' } }),
        bindAgent: async () => { /* no-op */ },
      },
      authorizeSurfaceIngress: async () => ({ allowed: true }),
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      trySpawnAgent: (input: { task: unknown }) => {
        spawned.push(JSON.stringify(input.task));
        return { id: `agent-${spawned.length}` };
      },
      queueSurfaceReplyFromBinding: () => { /* no-op */ },
    }) as never,
  });

  return {
    supervisor,
    telegram,
    spawned,
    conflicts,
    offsetPath,
    config,
    cleanup(): void { rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Per-test budget for this file.
 *
 * Every test here drives a real supervisor through polling intervals and waits
 * on `waitFor`, whose own ceiling is 10s (30s for the blocked-webhook case).
 * Bun's default per-test timeout is 5s, so those ceilings could never be
 * reached: under parallel full-suite load the runner killed the test before its
 * own deadline, and the failure read as a product bug rather than as the budget
 * mismatch it was. The budget is set above the largest ceiling so a failure here
 * means the behaviour did not happen, not that the machine was busy.
 */
const TEST_BUDGET_MS = 45_000;

async function waitFor(predicate: () => boolean, label: string, ceilingMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > ceilingMs) throw new Error(`telegram ingress: ${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── mode selection ──────────────────────────────────────────────────────────

describe('telegram ingress — mode selection is explicit and exclusive', () => {
  test('polling mode clears any registered webhook before polling, and never registers one', async () => {
    const h = makeHarness();
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);

      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');

      // Mutual exclusion, enforced rather than assumed: Telegram answers
      // getUpdates with 409 while a webhook is registered, so polling must
      // delete it first — and must never register one itself.
      const methods = h.telegram.calls.map((call) => call.method);
      expect(methods[0]).toBe('deleteWebhook');
      expect(methods).toContain('getUpdates');
      expect(methods).not.toContain('setWebhook');
      // Queued updates are handed to the poller, not discarded.
      expect(h.telegram.calls[0]?.body.drop_pending_updates).toBe(false);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('webhook mode registers the URL with the secret token and never polls', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.mode': 'webhook', 'surfaces.telegram.webhookSecret': 'shared-secret' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('webhook');
      // No loop at all in webhook mode — the other half of mutual exclusion.
      expect(status.running).toBe(false);

      const setWebhook = h.telegram.calls.find((call) => call.method === 'setWebhook');
      expect(setWebhook?.body.url).toBe('https://daemon.example.com/webhook/telegram');
      // Satisfies the x-telegram-bot-api-secret-token check in the handler.
      expect(setWebhook?.body.secret_token).toBe('shared-secret');

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.telegram.countOf('getUpdates')).toBe(0);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('webhook mode refuses a URL Telegram cannot reach, and says what to do', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.mode': 'webhook', 'web.publicBaseUrl': 'http://127.0.0.1:3423' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('mode=polling');
      // Registering a webhook Telegram can never deliver to is worse than not
      // registering one: it looks configured and silently receives nothing.
      expect(h.telegram.countOf('setWebhook')).toBe(0);
    } finally {
      await h.supervisor.stop();
      h.cleanup();
    }
  }, TEST_BUDGET_MS);

  test('rejects loopback, private, and plain-HTTP base URLs', () => {
    expect(describeWebhookUrlProblem('https://daemon.example.com')).toBeNull();
    expect(describeWebhookUrlProblem('')).toContain('no public base URL');
    expect(describeWebhookUrlProblem('http://daemon.example.com')).toContain('HTTPS');
    expect(describeWebhookUrlProblem('https://127.0.0.1:3423')).toContain('cannot reach');
    expect(describeWebhookUrlProblem('https://192.168.1.10')).toContain('cannot reach');
    expect(describeWebhookUrlProblem('https://box.local')).toContain('cannot reach');
  }, TEST_BUDGET_MS);
});

// ── reconfiguration ─────────────────────────────────────────────────────────

describe('telegram ingress — reconfiguration leaves no state behind', () => {
  test('switching webhook to polling swaps modes without leaving both armed', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook' } });
    try {
      expect((await h.supervisor.start()).mode).toBe('webhook');
      expect(h.telegram.countOf('setWebhook')).toBe(1);

      h.config['surfaces.telegram.mode'] = 'polling';
      const status = await h.supervisor.start();

      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);
      // The webhook registered a moment ago is retracted, so getUpdates is not
      // permanently blocked by the previous mode.
      expect(h.telegram.countOf('deleteWebhook')).toBeGreaterThanOrEqual(1);
      expect(h.telegram.countOf('setWebhook')).toBe(1);
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'polling after the switch');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('disabling the surface retracts the webhook this deployment registered', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook' } });
    try {
      await h.supervisor.start();
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://daemon.example.com/webhook/telegram' }));

      h.config['surfaces.telegram.enabled'] = false;
      const status = await h.supervisor.start();

      expect(status.mode).toBe('inactive');
      // Telegram keeps pushing to a registered URL forever otherwise.
      expect(h.telegram.countOf('deleteWebhook')).toBe(1);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('disabling never tears down a webhook belonging to another deployment', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.mode': 'webhook' } });
    try {
      await h.supervisor.start();
      // The same bot token, driven by somebody else's daemon.
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://someone-else.example.com/webhook/telegram' }));

      h.config['surfaces.telegram.enabled'] = false;
      await h.supervisor.start();

      expect(h.telegram.countOf('deleteWebhook')).toBe(0);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── diagnostics instead of silence ──────────────────────────────────────────

describe('telegram ingress — a configured surface that cannot receive says so', () => {
  test('a token with the surface disabled reports the half-finished setup', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.enabled': false } });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.enabled is false');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('enabled with no resolvable token names the settings to fix', async () => {
    const h = makeHarness({ config: { 'surfaces.telegram.botToken': '' } });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('inactive');
      expect(status.reason).toContain('surfaces.telegram.botToken');
      expect(status.reason).toContain('TELEGRAM_BOT_TOKEN');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('the bot token resolves through a secret reference, not only a literal', async () => {
    const h = makeHarness({
      config: { 'surfaces.telegram.botToken': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN' },
      secrets: { GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN: '123456:from-secret-store' },
    });
    try {
      const status = await h.supervisor.start();
      expect(status.mode).toBe('polling');
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── the poll loop ───────────────────────────────────────────────────────────

describe('telegram ingress — polled updates reach the shared handler', () => {
  test('a polled message is dispatched through the same path as a webhook update', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([textUpdate(101, 'triage the build')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'a polled update spawning an agent');
      expect(h.spawned).toHaveLength(1);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a polled /start onboards and does not spawn an agent', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([textUpdate(102, '/start')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('sendMessage') > 0, 'an onboarding reply');
      expect(h.spawned).toHaveLength(0);
      const sent = h.telegram.calls.find((call) => call.method === 'sendMessage');
      expect(String(sent?.text ?? sent?.body.text)).toContain('GoodVibes is connected');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('stop() ends the loop promptly and aborts the in-flight long poll', async () => {
    const h = makeHarness();
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
      const startedAt = Date.now();
      await h.supervisor.stop();
      // The poll is held open for Telegram's full window; shutdown must not
      // wait it out.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(h.supervisor.status.running).toBe(false);

      const pollsAtStop = h.telegram.countOf('getUpdates');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.telegram.countOf('getUpdates')).toBe(pollsAtStop);
    } finally { h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── failure handling ────────────────────────────────────────────────────────

describe('telegram ingress — errors are classified, not blindly retried', () => {
  test('a 409 conflict clears the webhook and resumes rather than backing off', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates',
      () => apiError(409, 'Conflict: can\'t use getUpdates method while webhook is active'),
      () => ok([textUpdate(201, 'after the conflict cleared')]),
    );
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'recovery from the webhook conflict');
      // Recovery is an actual deleteWebhook, not just a sleep: the startup call
      // plus one conflict recovery.
      expect(h.telegram.countOf('deleteWebhook')).toBeGreaterThanOrEqual(2);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a webhook that will not clear says so loudly and KEEPS RETRYING', async () => {
    const h = makeHarness();
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: webhook is active'));
      // Telegram genuinely reports one, so this is the proven-webhook case.
      h.telegram.queue('getWebhookInfo', () => ok({ url: 'https://stuck.example.com/hook' }));
    }
    try {
      await h.supervisor.start();
      await waitFor(
        () => h.supervisor.status.reason.includes('a webhook is registered for this bot'),
        'the blocked-on-webhook report',
        30_000,
      );
      const status = h.supervisor.status;
      // The operator gets the fix...
      expect(status.reason).toContain('surfaces.telegram.mode=webhook');
      expect(status.reason).toContain('will resume by itself');
      // ...and the loop is STILL ALIVE. This is the regression: it used to go
      // inactive here and stay dead until a human restarted the daemon.
      expect(status.mode).toBe('polling');
      expect(status.running).toBe(true);
      const pollsWhenBlocked = h.telegram.countOf('getUpdates');
      await waitFor(
        () => h.telegram.countOf('getUpdates') > pollsWhenBlocked,
        'polling to continue after the surface was reported blocked',
        30_000,
      );
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('the live repro: a 409 blaming a webhook when none is registered is a competing consumer, not a dead end', async () => {
    // Exactly what happened on the owner's machine: 409s that logged as a
    // webhook conflict, getWebhookInfo reporting NO webhook, deleteWebhook
    // running and changing nothing, and the loop then stopping forever.
    const h = makeHarness();
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, "Conflict: can't use getUpdates method while webhook is active"));
      h.telegram.queue('getWebhookInfo', () => ok({ url: '' }));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the competing-consumer report', 30_000);
      // Classified from evidence, not from the description string.
      expect(h.conflicts[0]).toContain('another process is already long-polling this bot token');
      expect(h.conflicts[0]).toContain('no webhook registered');
      // Never terminal.
      expect(h.supervisor.status.mode).toBe('polling');
      expect(h.supervisor.status.running).toBe(true);
      const polls = h.telegram.countOf('getUpdates');
      await waitFor(() => h.telegram.countOf('getUpdates') > polls, 'polling to keep going', 30_000);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('with clustering OFF a competing consumer is retried, because there is no election to stand down to', async () => {
    const h = makeHarness({ config: { 'cluster.enabled': false } });
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the competing-consumer report', 30_000);
      expect(h.conflicts[0]).toContain('Clustering is off');
      expect(h.conflicts[0]).toContain('backing off and retrying');
      expect(h.supervisor.status.running).toBe(true);
      // A webhook was never implicated, so nothing pointless was deleted.
      expect(h.telegram.countOf('deleteWebhook')).toBe(1); // the startup clear only
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('with clustering ON the node stands down for the election, and still retries', async () => {
    const h = makeHarness({ config: { 'cluster.enabled': true } });
    for (let i = 0; i < 12; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    try {
      await h.supervisor.start();
      await waitFor(() => h.conflicts.length > 0, 'the stand-down report', 30_000);
      expect(h.conflicts[0]).toContain('leader election');
      expect(h.supervisor.status.running).toBe(true);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('a poll that succeeds after a conflict clears the blocked status and delivers the message', async () => {
    const h = makeHarness();
    // Three conflicts, so the exponential backoff (1s, 2s, 4s) plus jitter
    // stays well inside the ceiling below — the point of this test is the
    // recovery, not the wait.
    for (let i = 0; i < 3; i += 1) {
      h.telegram.queue('getUpdates', () => apiError(409, 'Conflict: terminated by other getUpdates request'));
    }
    h.telegram.queue('getUpdates', () => ok([textUpdate(777, 'the message that was nearly lost')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'recovery after the other consumer went away', 30_000);
      // Recovery is real: the status goes back to the healthy sentence, so an
      // operator who was told the surface was dead is told it came back.
      expect(h.supervisor.status.reason).toContain('long-polling Telegram getUpdates');
      expect(h.supervisor.status.running).toBe(true);
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, 60_000);

  test('a rejected bot token stops immediately instead of retrying forever', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => apiError(401, 'Unauthorized'));
    try {
      await h.supervisor.start();
      await waitFor(() => h.supervisor.status.mode === 'inactive', 'the loop giving up on a bad token');
      expect(h.supervisor.status.reason).toContain('surfaces.telegram.botToken');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('stop() interrupts a long server-dictated backoff instead of waiting it out', async () => {
    const h = makeHarness();
    // Telegram asks for a 30s pause. Shutdown must not honour it.
    h.telegram.queue('getUpdates', () => apiError(429, 'Too Many Requests', 30));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'the rate-limited poll');
      // Let the loop get into its backoff sleep before stopping.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      await h.supervisor.stop();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally { h.cleanup(); }
  }, 15_000);

  test('one failing update does not wedge the cursor behind it', async () => {
    const h = makeHarness();
    h.telegram.queue('getUpdates', () => ok([
      // No chat id: the handler rejects it. The cursor must still advance.
      { update_id: 301, message: { text: 'broken' } },
      textUpdate(302, 'still gets through'),
    ]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.spawned.length > 0, 'the following update being processed');
      await waitFor(() => {
        try { return JSON.parse(readFileSync(h.offsetPath, 'utf-8')).offset === 303; } catch { return false; }
      }, 'the cursor advancing past both updates');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);
});

// ── offset persistence ──────────────────────────────────────────────────────

describe('telegram offset store — the cursor survives restarts', () => {
  test('the cursor is persisted after a batch and resumed on the next start', async () => {
    const first = makeHarness();
    first.telegram.queue('getUpdates', () => ok([textUpdate(500, 'first run')]));
    try {
      await first.supervisor.start();
      await waitFor(() => first.spawned.length > 0, 'the first batch');
      await waitFor(() => {
        try { return JSON.parse(readFileSync(first.offsetPath, 'utf-8')).offset === 501; } catch { return false; }
      }, 'the cursor being written');
    } finally { await first.supervisor.stop(); }

    // A restart must ask Telegram to continue from 501 — not replay, not skip.
    const second = makeHarness();
    rmSync(second.offsetPath, { force: true });
    mkdirSync(join(second.offsetPath, '..'), { recursive: true });
    writeFileSync(second.offsetPath, readFileSync(first.offsetPath, 'utf-8'));
    first.cleanup();
    try {
      await second.supervisor.start();
      await waitFor(() => second.telegram.countOf('getUpdates') > 0, 'a first poll after restart');
      const poll = second.telegram.calls.find((call) => call.method === 'getUpdates');
      expect(poll?.body.offset).toBe(501);
    } finally { await second.supervisor.stop(); second.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a first run with no cursor asks for the retained backlog', async () => {
    const h = makeHarness();
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'a first poll');
      const poll = h.telegram.calls.find((call) => call.method === 'getUpdates');
      // No offset: Telegram hands over what it still holds, so a /start sent
      // before the daemon was running is still answered.
      expect(poll?.body.offset).toBeUndefined();
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('a torn cursor is swept and the poller skips ahead rather than replaying', async () => {
    const h = makeHarness();
    writeFileSync(h.offsetPath, '{"version":1,"offset":'); // truncated mid-write
    h.telegram.queue('getUpdates', () => ok([textUpdate(900, 'newest message')]));
    try {
      await h.supervisor.start();
      await waitFor(() => h.telegram.countOf('getUpdates') > 0, 'the skip-ahead probe');
      const probe = h.telegram.calls.find((call) => call.method === 'getUpdates');
      // A negative offset asks for the tail of the queue; the backlog is
      // confirmed away instead of being re-dispatched as duplicate work.
      expect(probe?.body.offset).toBe(-1);
      expect(probe?.body.limit).toBe(1);
      await waitFor(() => {
        try { return JSON.parse(readFileSync(h.offsetPath, 'utf-8')).offset === 901; } catch { return false; }
      }, 'the cursor being rebuilt');
    } finally { await h.supervisor.stop(); h.cleanup(); }
  }, TEST_BUDGET_MS);

  test('the store validates by content, not by the file merely existing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-tg-store-'));
    const path = join(dir, 'offset.json');
    try {
      const store = new TelegramOffsetStore(path);
      expect(store.load()).toEqual({ mode: 'fresh' });

      store.save(42);
      expect(store.load()).toEqual({ mode: 'resume', offset: 42 });

      // Right shape, impossible value.
      writeFileSync(path, JSON.stringify({ version: 1, offset: -5 }));
      expect(store.load().mode).toBe('skip-ahead');
      // An unusable cursor is deleted, so it cannot fail every boot forever.
      expect(store.load()).toEqual({ mode: 'fresh' });

      writeFileSync(path, JSON.stringify({ version: 99, offset: 7 }));
      expect(store.load().mode).toBe('skip-ahead');

      writeFileSync(path, 'x'.repeat(9_000));
      expect(store.load().mode).toBe('skip-ahead');

      store.save(Number.NaN);
      expect(store.load()).toEqual({ mode: 'fresh' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_BUDGET_MS);
});
