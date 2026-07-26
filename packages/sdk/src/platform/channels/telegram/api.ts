/**
 * api.ts — the slice of the Telegram Bot API the daemon actually calls.
 *
 * Deliberately small: getUpdates for polling ingress, the webhook trio for
 * webhook ingress, and sendMessage for onboarding replies. Outbound task
 * replies keep going through the channel delivery strategy — this client is
 * not a second delivery path.
 *
 * Every call returns the Telegram `result` payload or throws TelegramApiError
 * carrying `error_code`, because the supervisor's behaviour depends on WHICH
 * error it was: 409 means a webhook is registered and polling can never work
 * until it is removed, and 429 carries a server-dictated retry delay. Treating
 * those as generic failures produces a loop that backs off forever against a
 * condition that backing off cannot fix.
 */

/** A Telegram API failure with the fields the supervisor branches on. */
export class TelegramApiError extends Error {
  /** Telegram's `error_code` (409 conflict, 401 unauthorized, 429 flood, …). */
  readonly errorCode: number | null;
  /** `parameters.retry_after` in seconds, when Telegram dictated a delay. */
  readonly retryAfterSeconds: number | null;
  /** HTTP status, for transport-level failures with no Telegram body. */
  readonly httpStatus: number | null;

  constructor(
    message: string,
    options: {
      readonly errorCode?: number | null;
      readonly retryAfterSeconds?: number | null;
      readonly httpStatus?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.errorCode = options.errorCode ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }

  /**
   * True when a webhook is registered and therefore getUpdates cannot run.
   * Telegram reports this as 409 Conflict.
   */
  get isWebhookConflict(): boolean {
    return this.errorCode === 409;
  }

  /** True when the bot token is missing, revoked, or wrong — never retryable. */
  get isUnauthorized(): boolean {
    return this.errorCode === 401 || this.errorCode === 403;
  }
}

/** One Telegram Update, kept as an opaque record — the adapter parses it. */
export type TelegramUpdate = Record<string, unknown>;

export interface TelegramWebhookInfo {
  readonly url: string;
  readonly pendingUpdateCount: number;
  readonly lastErrorMessage: string | undefined;
}

/** Who the configured bot token belongs to, per Telegram's own getMe. */
export interface TelegramBotIdentity {
  readonly id: string;
  /** The @handle, WITHOUT the leading '@'. */
  readonly username: string;
  readonly displayName: string;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Injectable fetch so tests drive the client without network access. */
export type TelegramFetch = (input: string, init: RequestInit) => Promise<Response>;

export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: TelegramFetch = ((input, init) => fetch(input, init)) as TelegramFetch,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  /**
   * Never interpolate the token into a log or error message. `describeToken`
   * exists so diagnostics can say WHICH token is configured without printing
   * it: bot ids are the prefix before the colon and are not secret.
   */
  get botId(): string {
    const [id] = this.token.split(':');
    return id && /^\d+$/.test(id) ? id : 'unknown';
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/bot${encodeURIComponent(this.token)}/${method}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      // An aborted long-poll is a normal shutdown, not a failure; let the
      // caller see the AbortError unchanged so it can tell them apart.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new TelegramApiError(
        `Telegram ${method} request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    const payload = readRecord(text ? JSON.parse(text) as unknown : null);
    if (payload?.ok === true) return payload.result;

    const description = typeof payload?.description === 'string'
      ? payload.description
      : `HTTP ${response.status}`;
    const parameters = readRecord(payload?.parameters);
    throw new TelegramApiError(`Telegram ${method} failed: ${description}`, {
      errorCode: readNumber(payload?.error_code) ?? response.status,
      retryAfterSeconds: readNumber(parameters?.retry_after),
      httpStatus: response.status,
    });
  }

  /**
   * Long-poll for updates. `timeoutSeconds` is Telegram's own hold-open
   * duration: the request stays open server-side until an update arrives or the
   * timeout expires, which is what makes polling cheap rather than a busy loop.
   */
  async getUpdates(options: {
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
    readonly timeoutSeconds: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<TelegramUpdate[]> {
    const result = await this.call('getUpdates', {
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      timeout: options.timeoutSeconds,
      // Ask only for update kinds the adapter handles, so an unrelated update
      // type cannot consume the offset without producing anything.
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    }, options.signal);
    return Array.isArray(result) ? result.filter((entry): entry is TelegramUpdate => readRecord(entry) !== null) : [];
  }

  /** Point Telegram at a public delivery URL, with the shared secret header. */
  async setWebhook(url: string, secretToken?: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      ...(secretToken ? { secret_token: secretToken } : {}),
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
    });
  }

  /**
   * Remove any registered webhook. `dropPendingUpdates` defaults to false so a
   * switch from webhook to polling HANDS the queued updates to the poller
   * instead of discarding messages the user already sent.
   */
  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  /**
   * Ask Telegram who this token belongs to.
   *
   * The bot's username is not a fact only the operator knows — the token
   * identifies the bot and Telegram hands back the handle for free. Making the
   * user type it, and degrading silently when they do not, is the product
   * declining to answer a question it can answer itself. An empty handle breaks
   * @mention matching in groups, mis-strips `/goodvibes@thebot`, answers
   * `/start@someotherbot` as if addressed to us, and collapses every bot's route
   * bindings onto the literal surfaceId 'telegram'.
   */
  async getMe(): Promise<TelegramBotIdentity> {
    const result = readRecord(await this.call('getMe', {}));
    const id = readNumber(result?.id);
    return {
      id: id === null ? this.botId : String(id),
      username: typeof result?.username === 'string' ? result.username.replace(/^@/, '').trim() : '',
      displayName: typeof result?.first_name === 'string' ? result.first_name : '',
    };
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const result = readRecord(await this.call('getWebhookInfo', {}));
    return {
      url: typeof result?.url === 'string' ? result.url : '',
      pendingUpdateCount: readNumber(result?.pending_update_count) ?? 0,
      lastErrorMessage: typeof result?.last_error_message === 'string' ? result.last_error_message : undefined,
    };
  }

  async sendMessage(input: {
    readonly chatId: string;
    readonly text: string;
    readonly threadId?: string | undefined;
  }): Promise<void> {
    await this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text.slice(0, 4_096),
      disable_web_page_preview: true,
      ...(input.threadId && /^\d+$/.test(input.threadId)
        ? { message_thread_id: Number(input.threadId) }
        : {}),
    });
  }
}
