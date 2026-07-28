/**
 * channel-health-runtime.test.ts — a channel's reported state answers "is this
 * working right now", not "is a token present in config".
 *
 * The lived symptom: a Telegram bot whose ingress had died still reported
 * `healthy` on every surface, because the reported state was computed from
 * credential presence alone. `BuiltinChannelRuntime.telegramIngressStatus()`
 * existed and knew the truth, and nothing called it. Four surfaces were worse
 * still — Slack, Discord, ntfy and the generic webhook reported `healthy`
 * whenever their delivery switch was on, without checking for a credential at
 * all.
 *
 * Each test here fails against the shape that shipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPluginRegistry } from '../packages/sdk/src/platform/channels/plugin-registry.js';
import { BuiltinChannelRuntime } from '../packages/sdk/src/platform/channels/builtin-runtime.js';
import { ChannelHealthWatcher, type ChannelHealthAlert } from '../packages/sdk/src/platform/channels/health-watcher.js';
import { observeTelegramRuntime } from '../packages/sdk/src/platform/channels/builtin/health.js';
import { resolveChannelHealthState } from '../packages/sdk/src/platform/channels/health.js';
import type { ProviderRuntimeStatus } from '../packages/sdk/src/platform/channels/provider-runtime.js';
import type { ChannelStatusSnapshot } from '../packages/sdk/src/platform/channels/types.js';
import type { BuiltinChannelRuntimeDeps } from '../packages/sdk/src/platform/channels/builtin/shared.js';

// ── harness ─────────────────────────────────────────────────────────────────

interface DepsOverrides {
  /** Per-surface config, merged into the `surfaces.<name>` sections. */
  readonly surfaces?: Record<string, Record<string, unknown>>;
  /** Top-level config keys, e.g. `web.publicBaseUrl`. */
  readonly config?: Record<string, unknown>;
  readonly deliveryEnabled?: (surface: string) => boolean;
  readonly providerRuntimeStatus?: ((surface: string) => ProviderRuntimeStatus | null) | undefined;
  readonly telegramOffsetPath?: string | undefined;
  /**
   * This process's secret store, keyed the way a `goodvibes://secrets/<store>/<key>`
   * reference addresses it. Absent or `emptySecretStore` models the daemon's
   * `secrets.enc` being `{}` while another surface's store holds the key.
   */
  readonly secrets?: Record<string, string> | undefined;
  readonly emptySecretStore?: boolean | undefined;
}

const SURFACE_SECTIONS = [
  'slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'googleChat',
  'signal', 'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
] as const;

function createDeps(channelPlugins: ChannelPluginRegistry, overrides: DepsOverrides = {}): BuiltinChannelRuntimeDeps {
  const surfaces: Record<string, Record<string, unknown>> = {};
  for (const section of SURFACE_SECTIONS) surfaces[section] = {};
  surfaces['whatsapp'] = { provider: 'meta-cloud' };
  surfaces['telephony'] = { provider: 'twilio' };
  for (const [section, values] of Object.entries(overrides.surfaces ?? {})) {
    surfaces[section] = { ...surfaces[section], ...values };
  }
  const flat = new Map<string, unknown>(Object.entries(overrides.config ?? {}));
  for (const [section, values] of Object.entries(surfaces)) {
    for (const [key, value] of Object.entries(values)) flat.set(`surfaces.${section}.${key}`, value);
  }
  return {
    channelPlugins,
    configManager: {
      get: (key: string) => flat.get(key),
      getCategory: () => surfaces,
      set: (key: string, value: unknown) => { flat.set(key, value); },
      subscribe: () => () => undefined,
    },
    // A `goodvibes://secrets/goodvibes/<KEY>` reference resolves by asking THIS
    // process's secrets manager for `<KEY>`. An empty store is the daemon's
    // `secrets.enc` being `{}` while the agent's and the TUI's stores hold it.
    secretsManager: {
      get: async (key: string) => (overrides.emptySecretStore ? null : overrides.secrets?.[key] ?? null),
      set: async () => undefined,
      getGlobalHome: () => undefined,
    },
    serviceRegistry: { get: () => undefined, resolveSecret: async () => null },
    routeBindings: { start: async () => undefined, getBinding: () => undefined, listBindings: () => [] },
    channelPolicy: {
      start: async () => undefined,
      getPolicy: () => undefined,
      upsertPolicy: async (_surface: string, input: Record<string, unknown>) => input,
    },
    deliveryRouter: {},
    ...(overrides.providerRuntimeStatus
      ? { providerRuntime: { status: overrides.providerRuntimeStatus } }
      : {}),
    ...(overrides.telegramOffsetPath ? { telegramOffsetPath: overrides.telegramOffsetPath } : {}),
    surfaceDeliveryEnabled: overrides.deliveryEnabled ?? (() => false),
    buildSurfaceAdapterContext: () => ({}),
    buildGenericWebhookAdapterContext: () => ({}),
    deliverSurfaceProgress: async () => undefined,
    deliverSlackAgentReply: async () => undefined,
    deliverDiscordAgentReply: async () => undefined,
    deliverNtfyAgentReply: async () => undefined,
    deliverWebhookAgentReply: async () => undefined,
    deliverSlackApprovalUpdate: async () => undefined,
    deliverDiscordApprovalUpdate: async () => undefined,
    deliverNtfyApprovalUpdate: async () => undefined,
    deliverWebhookApprovalUpdate: async () => undefined,
  } as unknown as BuiltinChannelRuntimeDeps;
}

async function statusFor(
  surface: string,
  overrides: DepsOverrides = {},
): Promise<{ snapshot: ChannelStatusSnapshot; runtime: BuiltinChannelRuntime }> {
  const registry = new ChannelPluginRegistry();
  const runtime = new BuiltinChannelRuntime(createDeps(registry, overrides));
  runtime.registerPlugins();
  const snapshot = (await registry.listStatus()).find((entry) => entry.surface === surface);
  if (!snapshot) throw new Error(`no status snapshot for ${surface}`);
  return { snapshot, runtime };
}

const LIVE_TELEGRAM = {
  enabled: true,
  botToken: 'a-real-looking-token',
  botUsername: 'gv_bot',
  discoveredBotTokenId: 'a-real-looking-token',
} as const;

const tempDirs: string[] = [];
function offsetPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'channel-health-'));
  tempDirs.push(dir);
  return join(dir, 'telegram-offset.json');
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── the shipped defect ──────────────────────────────────────────────────────

describe('channel health reflects the runtime, not the configuration', () => {
  test('a configured Telegram bot with dead ingress reports dead, not healthy', async () => {
    const { snapshot, runtime } = await statusFor('telegram', {
      surfaces: { telegram: { ...LIVE_TELEGRAM, mode: 'polling' } },
      deliveryEnabled: (surface) => surface === 'telegram',
    });

    // Ingress was never armed on this node — the shipped symptom exactly: the
    // token is present, nothing is reading updates, the owner gets no reply.
    expect(runtime.telegramIngressStatus()?.running ?? false).toBe(false);
    expect(snapshot.state).toBe('dead');
    expect(snapshot.configured).toBe(true);
    expect(snapshot.runtime?.observable).toBe(true);
    expect(snapshot.runtime?.reason).toContain('has not been started');
  });

  test('a configured Telegram bot with live ingress reports healthy', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ok: true, result: true }),
      { headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    try {
      const registry = new ChannelPluginRegistry();
      const runtime = new BuiltinChannelRuntime(createDeps(registry, {
        surfaces: { telegram: { ...LIVE_TELEGRAM, mode: 'webhook', webhookSecret: 'shhh' } },
        config: { 'web.publicBaseUrl': 'https://example.invalid' },
        deliveryEnabled: (surface) => surface === 'telegram',
        telegramOffsetPath: offsetPath(),
      }));
      runtime.registerPlugins();
      await runtime.startIngress();

      const snapshot = (await registry.listStatus()).find((entry) => entry.surface === 'telegram');
      expect(runtime.telegramIngressStatus()?.mode).toBe('webhook');
      expect(snapshot?.state).toBe('healthy');
      expect(snapshot?.runtime?.observable).toBe(true);
      await runtime.stopIngress();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('an unconfigured channel is distinguishable from both', async () => {
    const { snapshot } = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true } },
      deliveryEnabled: (surface) => surface === 'telegram',
    });
    expect(snapshot.state).toBe('unconfigured');
    expect(snapshot.configured).toBe(false);
  });

  test('a switched-off channel reports disabled, not dead', async () => {
    const { snapshot } = await statusFor('telegram', {
      surfaces: { telegram: { ...LIVE_TELEGRAM, enabled: false } },
      deliveryEnabled: () => false,
    });
    expect(snapshot.state).toBe('disabled');
  });

  test('a channel that cannot determine its runtime state reports unknown, never healthy', async () => {
    const { snapshot } = await statusFor('matrix', {
      surfaces: { matrix: { accessToken: 'syt_token', userId: '@gv:example.invalid' } },
      deliveryEnabled: (surface) => surface === 'matrix',
    });
    expect(snapshot.state).toBe('unknown');
    expect(snapshot.runtime?.observable).toBe(false);
    expect(snapshot.runtime?.running).toBeNull();
    // The second group must SAY that configuration is all it knows.
    expect(snapshot.runtime?.reason).toContain('Configuration is all this status knows');
  });

  test('Slack reports the provider connection, not the delivery switch', async () => {
    const down: ProviderRuntimeStatus = {
      surface: 'slack',
      running: false,
      configured: true,
      transport: 'socket-mode',
      lastError: 'socket closed by the server',
      metadata: {},
    };
    const dead = await statusFor('slack', {
      surfaces: { slack: { botToken: 'xoxb-token', workspaceId: 'T1' } },
      deliveryEnabled: (surface) => surface === 'slack',
      providerRuntimeStatus: () => down,
    });
    expect(dead.snapshot.state).toBe('dead');
    expect(dead.snapshot.runtime?.lastError).toBe('socket closed by the server');

    const live = await statusFor('slack', {
      surfaces: { slack: { botToken: 'xoxb-token', workspaceId: 'T1' } },
      deliveryEnabled: (surface) => surface === 'slack',
      providerRuntimeStatus: () => ({ ...down, running: true, lastError: undefined }),
    });
    expect(live.snapshot.state).toBe('healthy');
  });

  test('a host that wired no provider runtime reports unknown, not healthy', async () => {
    const { snapshot } = await statusFor('discord', {
      surfaces: { discord: { botToken: 'discord-token', applicationId: 'A1' } },
      deliveryEnabled: (surface) => surface === 'discord',
    });
    expect(snapshot.state).toBe('unknown');
    expect(snapshot.runtime?.observable).toBe(false);
  });

  test('an enabled surface with no credential is never reported healthy', async () => {
    for (const surface of ['slack', 'discord', 'ntfy', 'webhook']) {
      const { snapshot } = await statusFor(surface, { deliveryEnabled: () => true });
      expect(`${surface}:${snapshot.state}`).toBe(`${surface}:unconfigured`);
    }
  });

  test('every snapshot carries the observation its state was derived from', async () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createDeps(registry, { deliveryEnabled: () => true })).registerPlugins();
    for (const snapshot of await registry.listStatus()) {
      expect(snapshot.runtime?.reason ?? '').not.toBe('');
      expect(typeof snapshot.configured).toBe('boolean');
    }
  });
});

// ── configured, and the credential resolves to nothing ──────────────────────

/**
 * The shape measured on this project's own machine on 2026-07-28:
 *
 *   daemon/secrets.enc  ->  {}                                       EMPTY
 *   agent/secrets.enc   ->  GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN
 *   tui/secrets.enc     ->  TELEGRAM_BOT_TOKEN
 *
 * with daemon/settings.json holding
 * `goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN`. Every send from the daemon
 * failed with "Missing Telegram bot token"; the agent's own path succeeded
 * because it resolves through its own store. Both reported the same health.
 *
 * The store is faked here through the secrets manager seam rather than by
 * writing an encrypted store, because the fact under test is "the reference
 * resolves to nothing HERE", and that is the seam the resolver reads.
 */
const UNRESOLVABLE_REF = 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN';

describe('a declared credential that resolves to nothing is its own state', () => {
  test('a Telegram bot whose token reference resolves to nothing does not report healthy', async () => {
    const { snapshot } = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE_REF, botUsername: 'gv_bot', mode: 'polling' } },
      deliveryEnabled: (surface) => surface === 'telegram',
      emptySecretStore: true,
    });
    expect(snapshot.state).toBe('unresolved');
    expect(snapshot.configured).toBe(true);
    expect(snapshot.credentialResolves).toBe(false);
    expect(snapshot.runtime?.reason).toContain('does not resolve in the store');
  });

  test('the same surface with a resolvable reference is not reported unresolved', async () => {
    const { snapshot } = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE_REF, botUsername: 'gv_bot', mode: 'polling' } },
      deliveryEnabled: (surface) => surface === 'telegram',
      // Same config; this process's store holds the key the reference names.
      secrets: { TELEGRAM_BOT_TOKEN: 'a-real-looking-token' },
    });
    expect(snapshot.credentialResolves).toBe(true);
    expect(snapshot.state).toBe('dead'); // ingress still not armed — a different fault, named differently
  });

  test('unresolved is distinguishable from unconfigured', async () => {
    const declared = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE_REF } },
      deliveryEnabled: (surface) => surface === 'telegram',
      emptySecretStore: true,
    });
    const nothing = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true } },
      deliveryEnabled: (surface) => surface === 'telegram',
      emptySecretStore: true,
    });
    expect(declared.snapshot.state).toBe('unresolved');
    expect(nothing.snapshot.state).toBe('unconfigured');
  });

  test('the field that failed to resolve is named, not just the surface', async () => {
    const { snapshot } = await statusFor('telegram', {
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE_REF } },
      deliveryEnabled: (surface) => surface === 'telegram',
      emptySecretStore: true,
    });
    expect(snapshot.runtime?.reason).toContain('Bot token');
  });

  test('an unresolvable credential is a failure the owner is told about', async () => {
    const alerts: ChannelHealthAlert[] = [];
    const states = [snapshot('telegram', 'unresolved'), snapshot('matrix', 'unconfigured')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
    });
    await watcher.sweep();
    // Unresolved alerts (the owner believes it is set up); unconfigured does not.
    expect(alerts.map((entry) => entry.surface)).toEqual(['telegram']);
  });

  test('the doctor fails the resolve check and names the setting to fix', async () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createDeps(registry, {
      surfaces: { telegram: { enabled: true, botToken: UNRESOLVABLE_REF, botUsername: 'gv_bot', defaultChatId: '42' } },
      deliveryEnabled: (surface) => surface === 'telegram',
      emptySecretStore: true,
    })).registerPlugins();

    const report = await registry.doctor('telegram');
    expect(report?.state).toBe('unresolved');
    const check = report?.checks.find((entry) => entry.id === 'credentials-resolve');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('Bot token');
  });

  test('an observed working path outranks a credential this describer cannot resolve', () => {
    // A surface reading its token through a path the account describer does not
    // model must not be called broken on inference while it is demonstrably
    // carrying traffic. Direct evidence wins.
    const state = resolveChannelHealthState({
      enabled: true,
      configured: true,
      credentialResolves: false,
      runtime: { observable: true, running: true, reason: 'long-polling getUpdates' },
    });
    expect(state).toBe('healthy');
  });
});

// ── the same question, asked through `doctor` ───────────────────────────────

describe('the doctor answers the same health question as the status', () => {
  test('a configured Telegram bot with dead ingress does not pass its own examination', async () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createDeps(registry, {
      surfaces: { telegram: { ...LIVE_TELEGRAM, mode: 'polling', defaultChatId: '42' } },
      deliveryEnabled: (surface) => surface === 'telegram',
    })).registerPlugins();

    const report = await registry.doctor('telegram');
    expect(report?.state).toBe('dead');
    const runtimeCheck = report?.checks.find((check) => check.id === 'runtime');
    expect(runtimeCheck?.status).toBe('fail');
    expect(runtimeCheck?.detail).toContain('has not been started');
  });

  test('a surface whose liveness cannot be observed warns rather than passing quietly', async () => {
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(createDeps(registry, {
      surfaces: { matrix: { accessToken: 'syt_token', userId: '@gv:example.invalid', homeserverUrl: 'https://example.invalid' } },
      deliveryEnabled: (surface) => surface === 'matrix',
    })).registerPlugins();

    const report = await registry.doctor('matrix');
    expect(report?.state).toBe('unknown');
    expect(report?.checks.find((check) => check.id === 'runtime')?.status).toBe('warn');
  });
});

// ── the mapping rules, in isolation ─────────────────────────────────────────

describe('health state resolution', () => {
  test('an armed Telegram webhook is healthy even though no poll loop runs', () => {
    // Reading `running` alone would call a correctly armed webhook dead — the
    // same class of wrong answer pointing the other way.
    const observation = observeTelegramRuntime({
      mode: 'webhook',
      reason: 'Telegram updates will be delivered to https://example.invalid/webhook/telegram',
      running: false,
    });
    expect(observation.running).toBe(true);
    expect(resolveChannelHealthState({ enabled: true, configured: true, runtime: observation })).toBe('healthy');
  });

  test('an inactive supervisor carries its own named reason forward', () => {
    const observation = observeTelegramRuntime({
      mode: 'inactive',
      reason: 'the bot token was rejected; check surfaces.telegram.botToken',
      running: false,
    });
    expect(resolveChannelHealthState({ enabled: true, configured: true, runtime: observation })).toBe('dead');
    expect(observation.reason).toContain('surfaces.telegram.botToken');
  });

  test('a running path that still reports a failure is degraded, not healthy', () => {
    // No built-in observer produces this today — the provider manager clears
    // lastError on a successful start, and an error marks the surface stopped.
    // The rule is pinned anyway: a plugin (or a future observer) that reports
    // "up, but the last attempt failed" must not be rounded up to healthy, and
    // the watcher treats degraded as failing.
    const state = resolveChannelHealthState({
      enabled: true,
      configured: true,
      runtime: { observable: true, running: true, reason: 'connected', lastError: 'last publish was rejected' },
    });
    expect(state).toBe('degraded');
  });

  test('an unobservable runtime never resolves to healthy, whatever else is true', () => {
    const state = resolveChannelHealthState({
      enabled: true,
      configured: true,
      runtime: { observable: false, running: null, reason: 'nothing watches this' },
    });
    expect(state).toBe('unknown');
  });
});

// ── surfacing: a dead channel must reach the owner ──────────────────────────

function snapshot(surface: string, state: ChannelStatusSnapshot['state']): ChannelStatusSnapshot {
  return {
    id: `surface:${surface}`,
    surface: surface as ChannelStatusSnapshot['surface'],
    label: surface,
    state,
    enabled: true,
    configured: true,
    runtime: { observable: true, running: state === 'healthy', reason: `${surface} reason` },
    metadata: {},
  };
}

describe('a dead channel is surfaced, not merely recorded', () => {
  test('a channel going dead produces an alert naming the surface and the reason', async () => {
    const alerts: ChannelHealthAlert[] = [];
    let states: ChannelStatusSnapshot[] = [snapshot('telegram', 'healthy'), snapshot('ntfy', 'healthy')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
    });

    await watcher.sweep();
    expect(alerts).toEqual([]);

    states = [snapshot('telegram', 'dead'), snapshot('ntfy', 'healthy')];
    await watcher.sweep();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('failed');
    expect(alerts[0]!.surface).toBe('telegram');
    expect(alerts[0]!.message).toContain('telegram reason');
  });

  test('a still-dead channel is not re-announced every sweep', async () => {
    const alerts: ChannelHealthAlert[] = [];
    const states = [snapshot('telegram', 'dead')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
    });
    await watcher.sweep();
    await watcher.sweep();
    await watcher.sweep();
    expect(alerts).toHaveLength(1);
  });

  test('a channel that was announced dead is announced again when it recovers', async () => {
    const alerts: ChannelHealthAlert[] = [];
    let states = [snapshot('telegram', 'dead')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
    });
    await watcher.sweep();
    states = [snapshot('telegram', 'healthy')];
    await watcher.sweep();
    expect(alerts.map((entry) => entry.kind)).toEqual(['failed', 'recovered']);
  });

  test('unknown is not treated as failure', async () => {
    const alerts: ChannelHealthAlert[] = [];
    const states = [snapshot('matrix', 'unknown'), snapshot('web', 'unknown')];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
    });
    await watcher.sweep();
    await watcher.sweep();
    expect(alerts).toEqual([]);
  });

  test('a still-failing channel is re-announced once the repeat interval passes', async () => {
    const alerts: ChannelHealthAlert[] = [];
    const states = [snapshot('telegram', 'dead')];
    let now = 1_000;
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => { alerts.push(alert); },
      repeatMs: 60_000,
      now: () => now,
    });
    await watcher.sweep();
    now += 30_000;
    await watcher.sweep();
    expect(alerts).toHaveLength(1);
    now += 40_000;
    await watcher.sweep();
    expect(alerts.map((entry) => entry.kind)).toEqual(['failed', 'still-failing']);
  });

  test('an announcer that throws does not stop the sweep', async () => {
    const states = [snapshot('telegram', 'dead'), snapshot('ntfy', 'dead')];
    const seen: string[] = [];
    const watcher = new ChannelHealthWatcher({
      listStatus: async () => states,
      announce: (alert) => {
        seen.push(alert.surface);
        throw new Error('delivery failed');
      },
    });
    const alerts = await watcher.sweep();
    expect(alerts).toHaveLength(2);
    expect(seen.sort()).toEqual(['ntfy', 'telegram']);
  });
});
