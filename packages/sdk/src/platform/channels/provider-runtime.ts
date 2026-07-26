import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import {
  DiscordGatewayClient,
  DiscordIntegration,
  NtfyIntegration,
  SlackIntegration,
  SlackSocketModeClient,
  createNtfyLiveSubscriptionSince,
  type DiscordGatewayDispatch,
  type NtfyMessage,
  type SlackSocketModeEnvelope,
  resolveGoodVibesNtfyTopics,
} from '../integrations/index.js';
import {
  type SurfaceAdapterContext,
  handleDiscordGatewayDispatchPayload,
  handleNtfySurfacePayload,
  handleSlackSurfacePayload,
} from '../adapters/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export type ProviderRuntimeSurface = 'slack' | 'discord' | 'ntfy';

export interface ProviderRuntimeStatus {
  readonly surface: ProviderRuntimeSurface;
  readonly running: boolean;
  readonly configured: boolean;
  readonly transport: 'socket-mode' | 'gateway' | 'json-stream';
  readonly lastStartedAt?: number | undefined;
  readonly lastStoppedAt?: number | undefined;
  readonly lastError?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/** Options that apply when a surface is (re)started. */
export interface ProviderRuntimeStartOptions {
  /**
   * Wall-clock ms to replay ntfy from — the last moment the previous
   * responsible node was heard from. Null or absent subscribes live.
   */
  readonly replayFromMs?: number | null | undefined;
}

export interface ProviderRuntimeActionResult {
  readonly ok: boolean;
  readonly surface: ProviderRuntimeSurface;
  readonly status: ProviderRuntimeStatus;
  readonly message: string;
}

interface ProviderRuntimeManagerDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
}

interface RuntimeState {
  running: boolean;
  lastStartedAt?: number | undefined;
  lastStoppedAt?: number | undefined;
  lastError?: string | undefined;
  metadata: Record<string, unknown>;
}

const DEFAULT_STATE: RuntimeState = {
  running: false,
  metadata: {},
};

export class ChannelProviderRuntimeManager {
  private slackClient: SlackSocketModeClient | null = null;
  private discordClient: DiscordGatewayClient | null = null;
  /**
   * One live subscription per TOPIC, not one stream carrying all of them.
   *
   * ntfy will happily serve `topic-a,topic-b` down a single connection, and
   * that is what this used to do — but it makes the three topics one
   * indivisible consumer. Under per-surface leadership each topic is its own
   * surface with its own election, so this node can hold the agent topic while
   * a second machine holds the chat topic, and starting or stopping either has
   * to be possible without disturbing the other. A blanket consumer cannot
   * express that; a map of independent streams can.
   */
  private readonly ntfyAborts = new Map<string, AbortController>();
  private readonly state: Record<ProviderRuntimeSurface, RuntimeState> = {
    slack: { ...DEFAULT_STATE, metadata: {} },
    discord: { ...DEFAULT_STATE, metadata: {} },
    ntfy: { ...DEFAULT_STATE, metadata: {} },
  };

  constructor(private readonly deps: ProviderRuntimeManagerDeps) {}

  /**
   * Start every surface the operator switched on, and account for every one of
   * them out loud.
   *
   * The previous shape skipped a surface whose precondition was unmet by simply
   * not entering the branch — an enabled Slack with no app token, an enabled
   * ntfy with no topic — and returned a result array the caller discards. The
   * operator's config said "on", the runtime did nothing, and no line anywhere
   * said why. An enabled surface that does not come up is now an ERROR naming
   * the surface, the reason, and the setting to change.
   */
  async startConfigured(options: ProviderRuntimeStartOptions = {}): Promise<ProviderRuntimeActionResult[]> {
    const results: ProviderRuntimeActionResult[] = [];
    const attempt = async (
      surface: ProviderRuntimeSurface,
      precondition: () => Promise<string | null> | string | null,
    ): Promise<void> => {
      if (!this.deps.configManager.get(`surfaces.${surface}.enabled` as Parameters<ConfigManager['get']>[0])) return;
      const missing = await precondition();
      if (missing) {
        this.markError(surface, missing);
        this.reportInert(surface, missing);
        return;
      }
      const result = await this.start(surface, options);
      results.push(result);
      if (!result.ok) this.reportInert(surface, result.message);
    };

    await attempt('slack', async () => (await this.resolveSlackAppToken())
      ? null
      : 'no Slack app-level token resolved; set surfaces.slack.appToken (a goodvibes://secrets/... reference is fine) or the SLACK_APP_TOKEN environment variable');
    await attempt('discord', async () => (await this.resolveDiscordBotToken())
      ? null
      : 'no Discord bot token resolved; set surfaces.discord.botToken (a goodvibes://secrets/... reference is fine) or the DISCORD_BOT_TOKEN environment variable');
    await attempt('ntfy', () => this.resolveNtfyTopics().length > 0
      ? null
      : 'no ntfy topic resolved; set surfaces.ntfy.agentTopic (and optionally chatTopic / remoteTopic)');
    return results;
  }

  /**
   * One inbound surface the operator enabled is not up. This is the single most
   * expensive state the daemon can be in — the config reads correct, the
   * process is healthy, and messages disappear — so it is stated at ERROR with
   * the operator's next action in it, not left to a status endpoint nobody
   * queries.
   */
  private reportInert(surface: ProviderRuntimeSurface, reason: string): void {
    logger.error(`${surface} is enabled but is NOT receiving messages`, { surface, action: reason });
  }

  async start(
    surface: ProviderRuntimeSurface,
    options: ProviderRuntimeStartOptions = {},
  ): Promise<ProviderRuntimeActionResult> {
    if (surface === 'slack') return this.startSlack();
    if (surface === 'discord') return this.startDiscord();
    return this.startNtfy(options);
  }

  stop(surface: ProviderRuntimeSurface): ProviderRuntimeActionResult {
    if (surface === 'slack') {
      this.slackClient?.stop();
      this.slackClient = null;
      this.markStopped('slack');
      return this.result('slack', true, 'Slack Socket Mode runtime stopped.');
    }
    if (surface === 'discord') {
      this.discordClient?.stop();
      this.discordClient = null;
      this.markStopped('discord');
      return this.result('discord', true, 'Discord Gateway runtime stopped.');
    }
    for (const topic of [...this.ntfyAborts.keys()]) this.abortNtfyTopic(topic);
    this.markStopped('ntfy');
    return this.result('ntfy', true, 'ntfy JSON stream runtime stopped.');
  }

  // ── per-topic ntfy control ────────────────────────────────────────────────

  /**
   * The ntfy server these topics live on.
   *
   * Part of a topic's surface identity: the same topic name on two different
   * servers is two unrelated surfaces, and a node reading a self-hosted server
   * must never stand down for a node reading ntfy.sh.
   */
  ntfyBaseUrl(): string {
    return String(this.deps.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh');
  }

  /** Every ntfy topic this node is configured to read. */
  ntfyTopics(): string[] {
    return this.resolveNtfyTopics();
  }

  /** Topics with a live subscription on this node right now. */
  runningNtfyTopics(): string[] {
    return [...this.ntfyAborts.keys()].sort();
  }

  /**
   * Subscribe to ONE topic. Idempotent per topic.
   *
   * `replayFromMs` is the last moment the previous holder of THIS topic was
   * heard from. ntfy keeps no per-subscriber cursor, so a takeover that
   * subscribed "from now" would silently lose everything published in the gap.
   */
  async startNtfyTopic(
    topic: string,
    options: ProviderRuntimeStartOptions = {},
  ): Promise<ProviderRuntimeActionResult> {
    if (this.ntfyAborts.has(topic)) {
      return this.result('ntfy', true, `ntfy topic subscription is already running.`);
    }
    const abort = new AbortController();
    this.ntfyAborts.set(topic, abort);
    const ntfy = new NtfyIntegration(this.ntfyBaseUrl(), await this.resolveNtfyToken() ?? undefined);
    const replayFromMs = options.replayFromMs ?? null;
    const since = replayFromMs === null
      ? createNtfyLiveSubscriptionSince()
      : createNtfyLiveSubscriptionSince(replayFromMs);
    this.markStarted('ntfy', {
      topics: this.runningNtfyTopics(),
      since,
      replayCachedMessages: replayFromMs !== null,
    });
    void ntfy.subscribeJsonStream(topic, (message) => this.handleNtfyMessage(message), {
      since,
      signal: abort.signal,
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const message = summarizeError(error);
      this.ntfyAborts.delete(topic);
      this.markError('ntfy', message);
      logger.warn('ChannelProviderRuntimeManager: ntfy stream failed', { error: message });
    });
    return this.result('ntfy', true, 'ntfy JSON stream runtime started.');
  }

  /**
   * Drop ONE topic's subscription.
   *
   * Synchronous underneath — aborting the controller closes the stream before
   * this returns — which is what lets the RESIGN that follows a handoff be an
   * honest claim that this node has stopped reading the topic.
   */
  stopNtfyTopic(topic: string): ProviderRuntimeActionResult {
    this.abortNtfyTopic(topic);
    if (this.ntfyAborts.size === 0) this.markStopped('ntfy');
    else this.markStarted('ntfy', { topics: this.runningNtfyTopics() });
    return this.result('ntfy', true, 'ntfy topic subscription stopped.');
  }

  private abortNtfyTopic(topic: string): void {
    const abort = this.ntfyAborts.get(topic);
    if (!abort) return;
    abort.abort();
    this.ntfyAborts.delete(topic);
  }

  stopAll(): void {
    this.stop('slack');
    this.stop('discord');
    this.stop('ntfy');
  }

  status(surface: ProviderRuntimeSurface): ProviderRuntimeStatus {
    const state = this.state[surface]!;
    return {
      surface,
      running: state.running,
      configured: this.isConfigured(surface),
      transport: surface === 'slack' ? 'socket-mode' : surface === 'discord' ? 'gateway' : 'json-stream',
      ...(state.lastStartedAt ? { lastStartedAt: state.lastStartedAt } : {}),
      ...(state.lastStoppedAt ? { lastStoppedAt: state.lastStoppedAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      metadata: { ...state.metadata },
    };
  }

  private async startSlack(): Promise<ProviderRuntimeActionResult> {
    if (this.slackClient?.isStarted) {
      return this.result('slack', true, 'Slack Socket Mode runtime is already running.');
    }
    const appToken = await this.resolveSlackAppToken();
    const botToken = await this.resolveSlackBotToken();
    if (!appToken) {
      this.markError('slack', 'Slack app-level token is required for Socket Mode.');
      return this.result('slack', false, 'Slack app-level token is required for Socket Mode.');
    }
    const slack = new SlackIntegration(
      await this.deps.serviceRegistry.resolveSecret('slack', 'webhookUrl') ?? process.env.SLACK_WEBHOOK_URL,
      botToken ?? undefined,
    );
    const client = new SlackSocketModeClient({
      appToken,
      integration: slack,
      onEnvelope: (envelope) => this.handleSlackEnvelope(envelope, slack),
    });
    try {
      const connection = await client.start();
      if (!connection.ok) {
        const message = connection.error ?? 'Slack Socket Mode connection failed.';
        this.markError('slack', message);
        return this.result('slack', false, message);
      }
      this.slackClient = client;
      this.markStarted('slack', { socketMode: true });
      return this.result('slack', true, 'Slack Socket Mode runtime started.');
    } catch (error) {
      const message = summarizeError(error);
      this.markError('slack', message);
      return this.result('slack', false, message);
    }
  }

  private async startDiscord(): Promise<ProviderRuntimeActionResult> {
    if (this.discordClient?.isStarted) {
      return this.result('discord', true, 'Discord Gateway runtime is already running.');
    }
    const botToken = await this.resolveDiscordBotToken();
    if (!botToken) {
      this.markError('discord', 'Discord bot token is required for Gateway runtime.');
      return this.result('discord', false, 'Discord bot token is required for Gateway runtime.');
    }
    const discord = new DiscordIntegration(
      await this.deps.serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL,
      botToken,
    );
    const client = new DiscordGatewayClient({
      token: botToken,
      integration: discord,
      onDispatch: (dispatch) => this.handleDiscordDispatch(dispatch, discord),
    });
    try {
      const gateway = await client.start();
      this.discordClient = client;
      this.markStarted('discord', { gatewayUrl: gateway.url, shards: gateway.shards });
      return this.result('discord', true, 'Discord Gateway runtime started.');
    } catch (error) {
      const message = summarizeError(error);
      this.markError('discord', message);
      return this.result('discord', false, message);
    }
  }

  /**
   * Subscribe to every configured topic, each as its own stream.
   *
   * This is the path taken when leadership is switched off — the node reads
   * everything it is configured for. Under leadership the facade registers one
   * gate per topic instead, and each gate calls `startNtfyTopic` for the single
   * topic it won.
   */
  private async startNtfy(options: ProviderRuntimeStartOptions = {}): Promise<ProviderRuntimeActionResult> {
    const topics = this.resolveNtfyTopics();
    if (topics.length === 0) {
      this.markError('ntfy', 'ntfy topic is required for subscription runtime.');
      return this.result('ntfy', false, 'ntfy topic is required for subscription runtime.');
    }
    for (const topic of topics) {
      await this.startNtfyTopic(topic, options);
    }
    return this.result('ntfy', true, 'ntfy JSON stream runtime started.');
  }

  private async handleSlackEnvelope(envelope: SlackSocketModeEnvelope, slack: SlackIntegration): Promise<void> {
    if (!envelope.payload || typeof envelope.payload !== 'object') return;
    await handleSlackSurfacePayload(envelope.payload, this.deps.buildSurfaceAdapterContext(), slack).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: Slack Socket Mode payload failed', {
        error: summarizeError(error),
      });
    });
  }

  private async handleDiscordDispatch(dispatch: DiscordGatewayDispatch, discord: DiscordIntegration): Promise<void> {
    await handleDiscordGatewayDispatchPayload(dispatch, this.deps.buildSurfaceAdapterContext(), discord).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: Discord Gateway dispatch failed', {
        eventType: dispatch.t,
        error: summarizeError(error),
      });
    });
  }

  private async handleNtfyMessage(message: NtfyMessage): Promise<void> {
    if (message.event !== 'message') return;
    await handleNtfySurfacePayload(message, this.deps.buildSurfaceAdapterContext()).catch((error: unknown) => {
      logger.warn('ChannelProviderRuntimeManager: ntfy message dispatch failed', {
        error: summarizeError(error),
      });
    });
  }

  private async resolveSlackBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('slack', 'primary');
    const configValue = await this.resolveConfigSecret(this.deps.configManager.get('surfaces.slack.botToken'));
    return serviceValue
      || configValue
      || process.env.SLACK_BOT_TOKEN
      || null;
  }

  private async resolveSlackAppToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('slack', 'appToken');
    const configValue = await this.resolveConfigSecret(this.deps.configManager.get('surfaces.slack.appToken'));
    return serviceValue
      || configValue
      || process.env.SLACK_APP_TOKEN
      || null;
  }

  private async resolveDiscordBotToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('discord', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.discord.botToken') || '')
      || process.env.DISCORD_BOT_TOKEN
      || null;
  }

  private async resolveNtfyToken(): Promise<string | null> {
    const serviceValue = await this.deps.serviceRegistry.resolveSecret('ntfy', 'primary');
    return serviceValue
      || String(this.deps.configManager.get('surfaces.ntfy.token') || '')
      || process.env.NTFY_ACCESS_TOKEN
      || null;
  }

  private resolveNtfyTopics(): string[] {
    return [...resolveGoodVibesNtfyTopics({
      chatTopic: String(this.deps.configManager.get('surfaces.ntfy.chatTopic') || ''),
      agentTopic: String(this.deps.configManager.get('surfaces.ntfy.agentTopic') || ''),
      remoteTopic: String(this.deps.configManager.get('surfaces.ntfy.remoteTopic') || ''),
    }).all];
  }

  /**
   * Does this node hold a usable credential for the surface RIGHT NOW?
   *
   * Asynchronous because a `goodvibes://secrets/...` reference resolves off
   * disk, and the answer decides whether this node is allowed to contest the
   * surface's election at all. A node that won a surface whose token does not
   * resolve would read nothing while the node that could read it stood down.
   */
  async hasCredentialFor(surface: ProviderRuntimeSurface): Promise<boolean> {
    if (surface === 'slack') return Boolean(await this.resolveSlackAppToken());
    if (surface === 'discord') return Boolean(await this.resolveDiscordBotToken());
    return this.resolveNtfyTopics().length > 0;
  }

  private isConfigured(surface: ProviderRuntimeSurface): boolean {
    if (surface === 'slack') {
      const slackService = this.deps.serviceRegistry.get('slack');
      return Boolean(
        this.deps.configManager.get('surfaces.slack.appToken')
        || process.env.SLACK_APP_TOKEN
        || slackService?.appTokenKey
        || slackService?.appTokenRef,
      );
    }
    if (surface === 'discord') {
      return Boolean(this.deps.configManager.get('surfaces.discord.botToken') || process.env.DISCORD_BOT_TOKEN);
    }
    return this.resolveNtfyTopics().length > 0;
  }

  private markStarted(surface: ProviderRuntimeSurface, metadata: Record<string, unknown>): void {
    this.state[surface] = {
      running: true,
      lastStartedAt: Date.now(),
      metadata,
    };
  }

  private markStopped(surface: ProviderRuntimeSurface): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastStoppedAt: Date.now(),
    };
  }

  private markError(surface: ProviderRuntimeSurface, error: string): void {
    this.state[surface] = {
      ...this.state[surface],
      running: false,
      lastError: error,
    };
  }

  private result(surface: ProviderRuntimeSurface, ok: boolean, message: string): ProviderRuntimeActionResult {
    return {
      ok,
      surface,
      status: this.status(surface),
      message,
    };
  }

  private async resolveConfigSecret(value: unknown): Promise<string | null> {
    return resolveSecretInput(value, {
      resolveLocalSecret: this.deps.secretsManager
        ? (key) => this.deps.secretsManager!.get(key)
        : undefined,
      homeDirectory: this.deps.secretsManager?.getGlobalHome?.() ?? undefined,
    });
  }
}
