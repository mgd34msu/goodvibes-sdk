/**
 * calendar-connector.ts — the high-level connector the agent drives. It ties the
 * provider profiles, the OAuth flows, the secret-backed token store, and the two API
 * clients into one surface: connect (auth-code or device-code), disconnect, list
 * accounts + their honest state, list calendars, list events (normalized + source-
 * labeled) across a window, and create an event routed to an explicitly chosen
 * provider. The network and (for the loopback flow) the redirect listener are
 * injected, so the whole thing runs against fakes with no real network or port.
 */

import {
  beginAuthCodeFlow,
  beginDeviceCodeFlow,
  completeAuthCodeFlow,
  pollDeviceCodeFlow,
  type Sleep,
} from './oauth-flow.js';
import { providerProfile, resolveClientConfig } from './oauth-providers.js';
import { CalendarTokenStore, type CalendarTokenStoreOptions } from './oauth-token-store.js';
import {
  createGoogleEvent,
  listGoogleCalendars,
  listGoogleEvents,
} from './google-calendar-api.js';
import {
  createGraphEvent,
  listGraphCalendars,
  listGraphEvents,
} from './microsoft-graph-api.js';
import type {
  AuthCodeFlowStart,
  CalendarProviderId,
  Clock,
  ConnectedAccount,
  ConnectionState,
  DeviceCodeFlowStart,
  HttpFetch,
  LoopbackListenerFactory,
  LoopbackWaiter,
  MergedCalendarEvent,
  NewCalendarEvent,
  OAuthClientOverrides,
  ProviderCalendar,
  ResolvedClientConfig,
  SecretStoreSlice,
  StoredTokenSet,
} from './oauth-types.js';

export interface CalendarConnectorOptions {
  readonly secrets: SecretStoreSlice;
  readonly fetchImpl: HttpFetch;
  readonly clock?: Clock;
  /** Required only for the auth-code (loopback) flow; device-code needs no listener. */
  readonly listenerFactory?: LoopbackListenerFactory;
  /** Injected delay for device-code polling; defaults to a real timer. */
  readonly sleep?: Sleep;
  readonly refreshLeewayMs?: number;
}

/** A time window for event listing, as ISO strings. */
export interface EventWindow {
  readonly timeMin: string;
  readonly timeMax: string;
}

export class CalendarConnector {
  private readonly secrets: SecretStoreSlice;
  private readonly fetchImpl: HttpFetch;
  private readonly clock: Clock;
  private readonly listenerFactory?: LoopbackListenerFactory;
  private readonly sleep: Sleep;
  private readonly store: CalendarTokenStore;

  constructor(options: CalendarConnectorOptions) {
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.clock = options.clock ?? (() => Date.now());
    if (options.listenerFactory) this.listenerFactory = options.listenerFactory;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const storeOptions: CalendarTokenStoreOptions = {
      secrets: options.secrets,
      clock: this.clock,
      ...(typeof options.refreshLeewayMs === 'number' ? { refreshLeewayMs: options.refreshLeewayMs } : {}),
    };
    this.store = new CalendarTokenStore(storeOptions);
  }

  /** Resolve the client config for a provider (profile + optional user overrides). */
  resolveConfig(provider: CalendarProviderId, overrides?: OAuthClientOverrides): ResolvedClientConfig {
    return resolveClientConfig(providerProfile(provider), overrides);
  }

  // --- Accounts / state -----------------------------------------------------

  listAccounts(): Promise<ConnectedAccount[]> {
    return this.store.listAccounts();
  }

  connectionState(provider: CalendarProviderId): Promise<ConnectionState> {
    return this.store.connectionState(provider);
  }

  // --- Connect: authorization-code (loopback) flow --------------------------

  /** Begin the loopback auth-code flow; returns the URL to open and the waiter. */
  async beginConnectAuthCode(
    config: ResolvedClientConfig,
  ): Promise<{ readonly start: AuthCodeFlowStart; readonly waiter: LoopbackWaiter }> {
    if (!this.listenerFactory) {
      throw new Error('No loopback listener is available; use the device-code flow for headless connect.');
    }
    return beginAuthCodeFlow(config, this.listenerFactory);
  }

  /** Complete the auth-code flow after the redirect delivered a code; saves tokens. */
  async completeConnectAuthCode(
    config: ResolvedClientConfig,
    input: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
  ): Promise<ConnectedAccount> {
    const tokens = await completeAuthCodeFlow(config, this.fetchImpl, input, this.clock());
    return this.persistConnection(config, tokens);
  }

  // --- Connect: device-code (headless) flow ---------------------------------

  /** Begin the device-code flow; returns the user code + verification URL to show. */
  beginConnectDeviceCode(config: ResolvedClientConfig): Promise<DeviceCodeFlowStart> {
    return beginDeviceCodeFlow(config, this.fetchImpl, this.clock());
  }

  /** Poll until the device code is approved, then save tokens. */
  async completeConnectDeviceCode(
    config: ResolvedClientConfig,
    start: DeviceCodeFlowStart,
  ): Promise<ConnectedAccount> {
    const tokens = await pollDeviceCodeFlow(config, this.fetchImpl, start, this.clock, this.sleep);
    return this.persistConnection(config, tokens);
  }

  // --- Disconnect -----------------------------------------------------------

  disconnect(
    provider: CalendarProviderId,
    overrides?: OAuthClientOverrides,
  ): Promise<{ readonly revokedRemotely: boolean }> {
    return this.store.disconnect(provider, this.resolveConfig(provider, overrides), this.fetchImpl);
  }

  // --- Read: calendars + events ---------------------------------------------

  /** List the provider's calendars (refreshing the token first when due). */
  async listCalendars(config: ResolvedClientConfig): Promise<ProviderCalendar[]> {
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    return config.provider === 'google'
      ? listGoogleCalendars(this.fetchImpl, token)
      : listGraphCalendars(this.fetchImpl, token);
  }

  /**
   * List events across all of the provider's calendars in a window, normalized into
   * the merged model and source-labeled. Callers merge this with A9's ICS/local
   * events into the unified /calendar view.
   */
  async listEvents(config: ResolvedClientConfig, window: EventWindow): Promise<MergedCalendarEvent[]> {
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    const calendars = config.provider === 'google'
      ? await listGoogleCalendars(this.fetchImpl, token)
      : await listGraphCalendars(this.fetchImpl, token);
    const out: MergedCalendarEvent[] = [];
    for (const calendar of calendars) {
      const events = config.provider === 'google'
        ? await listGoogleEvents(this.fetchImpl, token, {
            calendarId: calendar.id,
            calendarLabel: calendar.name,
            timeMin: window.timeMin,
            timeMax: window.timeMax,
          })
        : await listGraphEvents(this.fetchImpl, token, {
            calendarId: calendar.id,
            calendarLabel: calendar.name,
            start: window.timeMin,
            end: window.timeMax,
          });
      out.push(...events);
    }
    return out;
  }

  // --- Write: create an event on an explicitly chosen provider --------------

  async createEvent(
    config: ResolvedClientConfig,
    calendarId: string,
    calendarLabel: string,
    event: NewCalendarEvent,
  ): Promise<MergedCalendarEvent> {
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    return config.provider === 'google'
      ? createGoogleEvent(this.fetchImpl, token, calendarId, calendarLabel, event)
      : createGraphEvent(this.fetchImpl, token, calendarId, calendarLabel, event);
  }

  // --- internals ------------------------------------------------------------

  /** Save tokens + a best-effort enriched account label, and return the account. */
  private async persistConnection(config: ResolvedClientConfig, tokens: StoredTokenSet): Promise<ConnectedAccount> {
    const account: ConnectedAccount = {
      provider: config.provider,
      accountId: config.provider,
      label: await this.deriveLabel(config, tokens),
      scopes: tokens.scopes ?? config.scopes,
      connectedAt: this.clock(),
    };
    await this.store.save(config.provider, tokens, account);
    return account;
  }

  /**
   * Best-effort account label: the primary calendar id is the account email for
   * Google, and the primary calendar's name is a reasonable Outlook label. A failure
   * here must NOT fail the connection (the token is already valid), so it falls back
   * to the provider display name.
   */
  private async deriveLabel(config: ResolvedClientConfig, tokens: StoredTokenSet): Promise<string> {
    try {
      const calendars = config.provider === 'google'
        ? await listGoogleCalendars(this.fetchImpl, tokens.accessToken)
        : await listGraphCalendars(this.fetchImpl, tokens.accessToken);
      const primary = calendars.find((c) => c.primary) ?? calendars[0];
      if (primary) return config.provider === 'google' ? primary.id : primary.name;
    } catch {
      // fall through to the honest default
    }
    return config.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
  }
}
