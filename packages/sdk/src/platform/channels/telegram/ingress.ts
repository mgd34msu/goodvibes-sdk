/**
 * ingress.ts — supervises the Telegram INBOUND path.
 *
 * Background: registering `POST /webhook/telegram` is not the same as having
 * inbound Telegram. Telegram pushes nothing until it is told a URL exists
 * (setWebhook) or is asked for updates (getUpdates). With neither call wired
 * up, configuring a bot token produced a surface that could send but never
 * receive — outbound replies worked, so it looked half-alive rather than
 * broken. This supervisor is the missing half.
 *
 * Mode is decided by `surfaces.telegram.mode`, which is an explicit,
 * operator-visible setting rather than something inferred:
 *
 *   polling  — long-poll getUpdates. Works on a laptop, behind NAT, with no
 *              public hostname and no tunnel. This is the mode most people can
 *              actually run.
 *   webhook  — Telegram POSTs to a public HTTPS URL. Lower latency, but it
 *              requires an address Telegram's servers can reach.
 *
 * The two are mutually exclusive by construction, not by convention: Telegram
 * rejects getUpdates with 409 Conflict while a webhook is registered, so
 * polling deletes any registered webhook before its first poll, and webhook
 * mode never starts a loop. Exactly one path is armed per start(), and which
 * one — with the reason — is logged.
 */
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { SurfaceAdapterContext } from '../../adapters/types.js';
import { processTelegramUpdate } from '../../adapters/telegram/index.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { TelegramApiError, TelegramBotApi, type TelegramBotIdentity, type TelegramUpdate } from './api.js';
import { TelegramOffsetStore } from './offset-store.js';

/** Telegram holds the request open this long when there is nothing to report. */
const POLL_TIMEOUT_SECONDS = 25;
/** Backoff floor and ceiling for transient failures. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** How many times to clear a conflicting webhook before declaring it stuck. */
const MAX_WEBHOOK_CONFLICT_RECOVERIES = 3;
/** The route registered by the builtin channel plugin. */
const TELEGRAM_WEBHOOK_PATH = '/webhook/telegram';

export type TelegramIngressMode = 'polling' | 'webhook' | 'inactive';

export interface TelegramIngressStatus {
  readonly mode: TelegramIngressMode;
  /** Why this mode — and, when inactive, exactly what to fix. */
  readonly reason: string;
  readonly running: boolean;
}

export interface TelegramIngressDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  /** Where the getUpdates cursor lives; surface-scoped by the composition root. */
  readonly offsetFilePath: string;
  /** Test seam: swap in a client with an injected fetch. */
  readonly createApi?: ((token: string) => TelegramBotApi) | undefined;
  /**
   * Telegram told us another process is already long-polling this bot token.
   *
   * The poll loop stops itself and reports it here rather than retrying,
   * because retrying is fighting: each side's getUpdates terminates the
   * other's, and the user's messages land in whichever process happened to win
   * the last round. The cluster coordinator listens on this to stand down and
   * re-run the election.
   */
  readonly onConcurrentConsumerConflict?: ((detail: string) => void) | undefined;
}

/**
 * Telegram only delivers webhooks to a public HTTPS address. A loopback or
 * private-range URL is the single most likely misconfiguration (the daemon's
 * own default base URL is loopback), and silently accepting it produces a
 * webhook that is registered but never fires — indistinguishable from the bug
 * this file fixes. Reject it up front with a message naming the fix.
 */
export function describeWebhookUrlProblem(rawUrl: string): string | null {
  if (!rawUrl.trim()) {
    return 'no public base URL is configured (web.publicBaseUrl)';
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `web.publicBaseUrl is not a valid URL (${rawUrl})`;
  }
  if (url.protocol !== 'https:') {
    return `Telegram only delivers webhooks over HTTPS, but web.publicBaseUrl is ${url.protocol}//`;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  const isPrivate = /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith('.local');
  if (isLoopback || isPrivate) {
    return `web.publicBaseUrl points at ${url.hostname}, which Telegram's servers cannot reach`;
  }
  return null;
}

export class TelegramIngressSupervisor {
  private stopped = true;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** Who this bot is, per getMe — see resolveBotIdentity. */
  private botIdentity: TelegramBotIdentity | null = null;
  private currentStatus: TelegramIngressStatus = {
    mode: 'inactive',
    reason: 'not started',
    running: false,
  };

  constructor(private readonly deps: TelegramIngressDeps) {}

  get status(): TelegramIngressStatus {
    return this.currentStatus;
  }

  /** The resolved bot identity, or null when getMe has not succeeded yet. */
  get identity(): TelegramBotIdentity | null {
    return this.botIdentity;
  }

  /**
   * Arm exactly one ingress path. Safe to call repeatedly: an already-running
   * supervisor is stopped first, so a config change re-decides cleanly rather
   * than layering a second loop on top of the first.
   */
  async start(): Promise<TelegramIngressStatus> {
    await this.stop();

    const config = this.deps.configManager;
    const enabled = Boolean(config.get('surfaces.telegram.enabled'));
    const token = await this.resolveBotToken();

    if (!enabled) {
      // A webhook registered by a previous run is state living on Telegram's
      // servers, not ours: switching the surface off must retract it, or
      // Telegram keeps POSTing to a daemon that no longer wants the traffic.
      if (token) await this.retractOwnWebhook(token);
      // A token with the surface switched off is a common half-finished setup;
      // say so rather than staying silent, because the user believes it is on.
      return token
        ? this.settle('inactive',
            'a Telegram bot token is configured but surfaces.telegram.enabled is false; set it to true to receive messages',
            false, 'warn')
        : this.settle('inactive', 'the Telegram surface is disabled (surfaces.telegram.enabled=false)');
    }
    if (!token) {
      return this.settle('inactive',
        'the Telegram surface is enabled but no bot token resolved; set surfaces.telegram.botToken '
        + '(a goodvibes://secrets/... reference is fine) or the TELEGRAM_BOT_TOKEN environment variable');
    }

    const mode = String(config.get('surfaces.telegram.mode') ?? 'webhook');
    const api = this.deps.createApi?.(token) ?? new TelegramBotApi(token);

    // Learn who this bot is before arming ingress, so the very first message is
    // matched against a real handle rather than an empty string.
    await this.resolveBotIdentity(api, token);

    if (mode === 'polling') return this.startPolling(api);
    if (mode === 'webhook') return this.startWebhook(api);
    return this.settle('inactive', `surfaces.telegram.mode is "${mode}", which is not a supported ingress mode`);
  }

  /**
   * Terminate the poll loop promptly and drop any in-flight long-poll.
   *
   * The AbortController is released only AFTER the loop has settled. Clearing
   * it first would strand a loop that was mid-await when stop() ran: its next
   * backoff would find no signal to listen on and sleep the full interval,
   * holding shutdown for up to a minute.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    const loop = this.loop;
    this.loop = null;
    if (loop) await loop.catch(() => { /* loop reports its own failures */ });
    this.abort = null;
    if (this.currentStatus.running) {
      this.currentStatus = { ...this.currentStatus, running: false };
    }
  }

  // ── mode setup ────────────────────────────────────────────────────────────

  private async startWebhook(api: TelegramBotApi): Promise<TelegramIngressStatus> {
    const base = String(this.deps.configManager.get('web.publicBaseUrl') ?? '');
    const problem = describeWebhookUrlProblem(base);
    if (problem) {
      return this.settle('inactive',
        `Telegram webhook mode cannot start: ${problem}. `
        + 'Either publish the daemon at a public HTTPS URL, or set surfaces.telegram.mode=polling '
        + 'to receive messages without one.');
    }

    const secret = await this.resolveWebhookSecret();
    const url = `${base.replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}`;
    try {
      await api.setWebhook(url, secret || undefined);
    } catch (error) {
      return this.settle('inactive', `Telegram setWebhook failed: ${summarizeError(error)}`);
    }
    if (!secret) {
      logger.warn('Telegram ingress: webhook registered without a secret token', {
        detail: 'set surfaces.telegram.webhookSecret so inbound callbacks can be verified',
      });
    }
    // Webhook mode runs no loop at all, so polling cannot coexist with it.
    return this.settle('webhook', `Telegram updates will be delivered to ${url}`, false);
  }

  private async startPolling(api: TelegramBotApi): Promise<TelegramIngressStatus> {
    // Deleting first is what makes the two modes mutually exclusive: leaving a
    // stale webhook registered would make every getUpdates return 409.
    try {
      await api.deleteWebhook(false);
    } catch (error) {
      logger.warn('Telegram ingress: could not clear a registered webhook before polling', {
        error: summarizeError(error),
        detail: 'polling will report a conflict if one is still registered',
      });
    }

    this.stopped = false;
    this.abort = new AbortController();
    const store = new TelegramOffsetStore(this.deps.offsetFilePath);
    this.loop = this.runPollLoop(api, store);
    return this.settle('polling',
      `long-polling Telegram getUpdates for bot ${api.botId} (no public URL required)`, true);
  }

  // ── the poll loop ─────────────────────────────────────────────────────────

  private async runPollLoop(api: TelegramBotApi, store: TelegramOffsetStore): Promise<void> {
    const start = store.load();
    let offset: number | undefined = start.mode === 'resume' ? start.offset : undefined;
    let backoffMs = BACKOFF_MIN_MS;
    let conflictRecoveries = 0;

    if (start.mode === 'skip-ahead') {
      offset = await this.skipAhead(api, store);
    }

    while (!this.stopped) {
      try {
        const updates = await api.getUpdates({
          offset,
          timeoutSeconds: POLL_TIMEOUT_SECONDS,
          ...(this.abort ? { signal: this.abort.signal } : {}),
        });
        backoffMs = BACKOFF_MIN_MS;
        conflictRecoveries = 0;
        if (updates.length > 0) {
          offset = await this.dispatchBatch(updates, api, offset);
          if (offset !== undefined) store.save(offset);
        }
      } catch (error) {
        if (this.stopped || (error instanceof Error && error.name === 'AbortError')) return;

        const terminal = await this.handlePollError(error, api, () => {
          conflictRecoveries += 1;
          return conflictRecoveries;
        });
        if (terminal) {
          this.currentStatus = { mode: 'inactive', reason: terminal, running: false };
          return;
        }
        const dictated = error instanceof TelegramApiError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1_000
          : null;
        await this.delay(dictated ?? backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  /**
   * Classify a poll failure. Returns a terminal reason when retrying cannot
   * possibly help — a revoked token or a webhook that will not clear — so the
   * loop stops with an actionable message instead of backing off forever
   * against something only the operator can fix.
   */
  private async handlePollError(
    error: unknown,
    api: TelegramBotApi,
    countConflict: () => number,
  ): Promise<string | null> {
    if (error instanceof TelegramApiError && error.isConcurrentConsumerConflict) {
      const reason = 'Telegram polling stopped: another process is already long-polling this bot token '
        + `(${error.description || 'terminated by other getUpdates request'}). `
        + 'Two consumers cannot share one token, so this one stands down rather than fighting for it.';
      logger.warn('Telegram ingress: another consumer holds this bot token; standing down', {
        detail: error.description,
      });
      this.deps.onConcurrentConsumerConflict?.(reason);
      return reason;
    }

    if (error instanceof TelegramApiError && error.isWebhookConflict) {
      const attempt = countConflict();
      if (attempt > MAX_WEBHOOK_CONFLICT_RECOVERIES) {
        const reason = 'Telegram polling stopped: a webhook is still registered for this bot, and '
          + `${MAX_WEBHOOK_CONFLICT_RECOVERIES} attempts to remove it did not succeed. `
          + 'getUpdates and a registered webhook cannot both be active. Remove the webhook '
          + '(deleteWebhook) or set surfaces.telegram.mode=webhook.';
        logger.error('Telegram ingress: unrecoverable webhook conflict', { detail: reason });
        return reason;
      }
      logger.warn('Telegram ingress: a webhook is registered, so polling is blocked (409)', {
        attempt,
        action: 'removing the webhook and retrying',
      });
      try {
        await api.deleteWebhook(false);
      } catch (deleteError) {
        logger.warn('Telegram ingress: deleteWebhook failed while clearing a conflict', {
          error: summarizeError(deleteError),
        });
      }
      return null;
    }

    if (error instanceof TelegramApiError && error.isUnauthorized) {
      const reason = 'Telegram polling stopped: the bot token was rejected '
        + `(${error.message}). Check surfaces.telegram.botToken — a revoked or mistyped token `
        + 'cannot be recovered by retrying.';
      logger.error('Telegram ingress: bot token rejected', { detail: reason });
      return reason;
    }

    logger.warn('Telegram ingress: poll failed; backing off', { error: summarizeError(error) });
    return null;
  }

  /**
   * Recover from a torn cursor by jumping to the newest update. A negative
   * offset asks Telegram for the tail of the queue; the newest update is still
   * processed (it is most likely the message the user is waiting on), and
   * everything older is confirmed away rather than replayed.
   */
  private async skipAhead(api: TelegramBotApi, store: TelegramOffsetStore): Promise<number | undefined> {
    try {
      const latest = await api.getUpdates({ offset: -1, limit: 1, timeoutSeconds: 0 });
      const next = await this.dispatchBatch(latest, api, undefined);
      if (next !== undefined) {
        store.save(next);
        logger.warn('Telegram ingress: skipped ahead past an unusable cursor', { offset: next });
      }
      return next;
    } catch (error) {
      logger.warn('Telegram ingress: skip-ahead failed; starting from the retained backlog', {
        error: summarizeError(error),
      });
      return undefined;
    }
  }

  /**
   * Hand each update to the SAME processor the webhook route uses, then return
   * the confirmation offset. The offset advances past an update only after its
   * processing returned, so a crash mid-batch replays that batch instead of
   * losing it.
   */
  private async dispatchBatch(
    updates: readonly TelegramUpdate[],
    api: TelegramBotApi,
    current: number | undefined,
  ): Promise<number | undefined> {
    let offset = current;
    const context = this.deps.buildSurfaceAdapterContext();
    for (const update of updates) {
      if (this.stopped) break;
      const updateId = typeof update.update_id === 'number' ? update.update_id : null;
      try {
        await processTelegramUpdate(update, context, {
          sendMessage: (input) => api.sendMessage(input),
        });
      } catch (error) {
        // One bad update must not wedge the cursor: log it and move past it,
        // otherwise every subsequent poll redelivers the same failing update.
        logger.warn('Telegram ingress: update processing failed; advancing past it', {
          updateId,
          error: summarizeError(error),
        });
      }
      if (updateId !== null) offset = Math.max(offset ?? 0, updateId + 1);
    }
    return offset;
  }

  /**
   * Resolve the bot's own identity from its token and cache it in config.
   *
   * `surfaces.telegram.botUsername` being blank does NOT mean the bot has no
   * username — it means nobody typed one in. Telegram's getMe returns the
   * handle, id and display name for any valid token, so the daemon asks instead
   * of degrading: without a handle, @mentions in groups are not recognised,
   * `/goodvibes@thebot` is not stripped correctly, `/start@someotherbot` in a
   * shared group is answered as if it were ours, and route bindings from two
   * different bots collide on the literal surfaceId 'telegram'.
   *
   * Rules:
   * - An explicitly configured username WINS. A discovered value never
   *   overwrites an operator's choice; it only fills a blank.
   * - The discovery is keyed to the token, so rotating the token re-discovers
   *   rather than serving a stale handle.
   * - A failure never blocks startup. Ingress still arms — receiving messages
   *   matters more than perfect mention matching — but it says at warn level
   *   exactly what will not work until the call succeeds, and the next start()
   *   retries.
   */
  private async resolveBotIdentity(api: TelegramBotApi, token: string): Promise<void> {
    const config = this.deps.configManager;
    const configured = String(config.get('surfaces.telegram.botUsername') ?? '').replace(/^@/, '').trim();
    const cachedFor = String(config.get('surfaces.telegram.discoveredBotTokenId') ?? '');
    if (configured && cachedFor === api.botId) {
      this.botIdentity = { id: api.botId, username: configured, displayName: '' };
      return;
    }
    if (configured && cachedFor !== api.botId && cachedFor !== '') {
      // The handle on file belongs to a different token. Re-discover rather
      // than run a new bot under the previous bot's identity.
      logger.info('Telegram ingress: bot token changed; re-resolving the bot identity', { botId: api.botId });
    } else if (configured) {
      // Operator-supplied and never discovered — honour it, but still record
      // which token it belongs to so a later rotation is detected.
      this.botIdentity = { id: api.botId, username: configured, displayName: '' };
      this.rememberDiscoveredToken(api.botId);
      return;
    }

    let identity: TelegramBotIdentity;
    try {
      identity = await api.getMe();
    } catch (error) {
      logger.warn('Telegram ingress: could not resolve the bot username from its token', {
        botId: api.botId,
        error: summarizeError(error),
        impact: '@mentions in groups will not be recognised, /goodvibes@botname will not be stripped, '
          + 'and a /start addressed to another bot in a shared group may be answered as if it were ours',
        detail: 'set surfaces.telegram.botUsername manually, or restart the surface to retry getMe',
      });
      return;
    }
    if (!identity.username) {
      logger.warn('Telegram ingress: getMe returned no username for this bot', { botId: identity.id });
      return;
    }
    this.botIdentity = identity;
    try {
      if (!configured) config.set('surfaces.telegram.botUsername', identity.username);
      this.rememberDiscoveredToken(identity.id);
      logger.info('Telegram ingress: resolved the bot identity from its token', {
        botId: identity.id,
        botUsername: identity.username,
        displayName: identity.displayName,
      });
    } catch (error) {
      // Discovery still succeeded in memory; only the cache write failed.
      logger.warn('Telegram ingress: could not persist the discovered bot username', {
        botUsername: identity.username,
        error: summarizeError(error),
      });
    }
    void token;
  }

  private rememberDiscoveredToken(botId: string): void {
    try {
      this.deps.configManager.set('surfaces.telegram.discoveredBotTokenId', botId);
    } catch {
      // A host without this key in its schema simply re-discovers next start.
    }
  }

  /**
   * Remove a webhook THIS deployment registered, and only that one.
   *
   * Checked against the configured public base URL first, so disabling the
   * surface never silently tears down a webhook pointing somewhere else — the
   * same bot token may legitimately be driven by another deployment, and
   * deleting its registration would break a system we do not own.
   */
  private async retractOwnWebhook(token: string): Promise<void> {
    const base = String(this.deps.configManager.get('web.publicBaseUrl') ?? '').replace(/\/+$/, '');
    if (!base) return;
    const api = this.deps.createApi?.(token) ?? new TelegramBotApi(token);
    try {
      const info = await api.getWebhookInfo();
      if (!info.url || info.url !== `${base}${TELEGRAM_WEBHOOK_PATH}`) return;
      await api.deleteWebhook(false);
      logger.info('Telegram ingress: retracted the webhook for a disabled surface', { url: info.url });
    } catch (error) {
      logger.warn('Telegram ingress: could not retract the webhook for a disabled surface', {
        error: summarizeError(error),
      });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve the bot token through the secret-reference path, so config can hold
   * `goodvibes://secrets/...` rather than a literal token in a settings file.
   */
  private async resolveBotToken(): Promise<string> {
    const fromRegistry = await this.deps.serviceRegistry.resolveSecret('telegram', 'primary');
    if (fromRegistry) return fromRegistry;
    const fromConfig = await this.resolveConfigSecret(
      this.deps.configManager.get('surfaces.telegram.botToken'),
    );
    return fromConfig || process.env.TELEGRAM_BOT_TOKEN || '';
  }

  private async resolveWebhookSecret(): Promise<string> {
    const fromRegistry = await this.deps.serviceRegistry.resolveSecret('telegram', 'signingSecret');
    if (fromRegistry) return fromRegistry;
    const fromConfig = await this.resolveConfigSecret(
      this.deps.configManager.get('surfaces.telegram.webhookSecret'),
    );
    return fromConfig || process.env.TELEGRAM_WEBHOOK_SECRET || '';
  }

  private async resolveConfigSecret(value: unknown): Promise<string> {
    const resolved = await resolveSecretInput(value, {
      resolveLocalSecret: (key) => this.deps.secretsManager.get(key),
      homeDirectory: this.deps.secretsManager.getGlobalHome?.() ?? undefined,
    });
    return resolved ?? '';
  }

  /**
   * Sleep that wakes immediately on stop() rather than pinning shutdown.
   *
   * The abort listener is removed on the normal timeout path too: backoff can
   * run many times against one AbortController, and listeners that only unbind
   * when they fire would pile up on a long-lived signal.
   */
  private delay(ms: number): Promise<void> {
    // stop() may have landed while the caller was awaiting something else;
    // never begin a fresh backoff sleep for a loop that is already finished.
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private settle(
    mode: TelegramIngressMode,
    reason: string,
    running = false,
    severity?: 'warn',
  ): TelegramIngressStatus {
    this.currentStatus = { mode, reason, running };
    if (mode !== 'inactive') {
      logger.info('Telegram ingress active', { surface: 'telegram', mode, reason });
      return this.currentStatus;
    }
    if (severity === 'warn') {
      logger.warn('Telegram ingress is inactive', { surface: 'telegram', action: reason });
      return this.currentStatus;
    }
    // Never fail silently — and the level has to match what the operator
    // believes. An operator who switched the surface OFF and sees it inactive
    // has no problem; an operator who switched it ON and has an inert surface
    // has the most expensive failure in the system: the daemon looks healthy,
    // the config looks right, and messages vanish. Those are different events
    // and they get different levels.
    const enabled = Boolean(this.deps.configManager.get('surfaces.telegram.enabled'));
    if (enabled) {
      logger.error('Telegram is enabled but is NOT receiving messages', { surface: 'telegram', action: reason });
    } else {
      logger.info('Telegram ingress is inactive', { surface: 'telegram', reason });
    }
    return this.currentStatus;
  }
}
