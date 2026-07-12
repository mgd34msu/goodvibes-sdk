// relay/reachability.ts
//
// The daemon-side controller that decides whether the daemon should be reachable
// through the zero-knowledge relay, and owns the outbound registration's
// lifecycle. It sits between the daemon boot graph and the transport-level
// registration manager (createRelayDaemonRegistration), keeping the boot seam a
// couple of lines: the facade constructs one of these and calls start()/stop().
//
// Enablement is deliberately double-gated, mirroring how exec-sandbox gates
// itself: the `relay.enabled` setting AND the `relay-connect` capability gate
// AND a configured `relay.url` must all be true. Any one off keeps the daemon
// LAN-only with the relay path byte-for-byte inert.
//
// The daemon relay identity is generated once and persisted through an injected
// store (a thin adapter over the daemon SecretsManager), so pairing payloads
// stay valid across restarts. All I/O is injected, so this is fully testable
// without a daemon.

import {
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
  type RelayDaemonRegistration,
  type RelayRegistrationLogger,
  type RelayRegistrationStatus,
} from '@pellux/goodvibes-daemon-sdk';
import {
  deserializeRelayIdentity,
  generateRelayIdentity,
  randomBytes,
  serializeRelayIdentity,
  toBase64Url,
  type RelayKeyPair,
  type RelayPairingPayload,
  type SerializedRelayIdentity,
} from '@pellux/goodvibes-transport-core/relay';

/** Durable custody of the daemon's relay identity (adapter over SecretsManager). */
export interface RelayIdentityStore {
  load(): Promise<SerializedRelayIdentity | null>;
  save(identity: SerializedRelayIdentity): Promise<void>;
}

/** The `relay.*` config slice this controller reads. */
export interface RelayReachabilityConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly rendezvousId: string;
  readonly label: string;
}

export interface RelayReachabilityOptions {
  readonly config: RelayReachabilityConfig;
  /** Whether the `relay-connect` capability gate is on (relay.enabled). */
  readonly featureFlagEnabled: boolean;
  readonly identityStore: RelayIdentityStore;
  /** Replay a reconstructed request against the daemon (e.g. facade.handleRequest). */
  readonly dispatch: (req: Request) => Promise<Response | null>;
  /** Base URL used to resolve tunneled paths (host is irrelevant; routing is by path). */
  readonly localBaseUrl?: string;
  readonly webSocketImpl?: (url: string) => RelayClientWebSocket;
  /** Called with a freshly-generated rendezvous id so the caller can persist it. */
  readonly onRendezvousId?: (rid: string) => void;
  readonly logger?: RelayRegistrationLogger;
  readonly onStatusChange?: (status: RelayRegistrationStatus) => void;
}

/** The composed reachability controller. */
export interface RelayReachability {
  /** Start the outbound registration if enabled; otherwise a no-op. */
  start(): Promise<void>;
  /** Stop the outbound registration. */
  stop(): void;
  /** Current status, or `'disabled'` when the relay path is gated off. */
  readonly status: RelayRegistrationStatus | 'disabled';
  /** Mint a pairing payload a surface can scan, or null when disabled. */
  mintPairing(): Promise<RelayPairingPayload | null>;
}

function generateRendezvousId(): string {
  return `rid_${toBase64Url(randomBytes(24))}`;
}

/** Whether all three gates are satisfied. */
export function isRelayReachabilityEnabled(config: RelayReachabilityConfig, featureFlagEnabled: boolean): boolean {
  return config.enabled && featureFlagEnabled && config.url.trim().length > 0;
}

export function createRelayReachability(options: RelayReachabilityOptions): RelayReachability {
  const enabled = isRelayReachabilityEnabled(options.config, options.featureFlagEnabled);
  let registration: RelayDaemonRegistration | null = null;
  let identity: RelayKeyPair | null = null;

  async function loadOrCreateIdentity(): Promise<RelayKeyPair> {
    const existing = await options.identityStore.load();
    if (existing) return deserializeRelayIdentity(existing);
    const created = await generateRelayIdentity();
    await options.identityStore.save(await serializeRelayIdentity(created));
    return created;
  }

  return {
    async start(): Promise<void> {
      if (!enabled || registration) return;
      identity = await loadOrCreateIdentity();
      let rid = options.config.rendezvousId.trim();
      if (!rid) {
        rid = generateRendezvousId();
        options.onRendezvousId?.(rid);
      }
      registration = createRelayDaemonRegistration({
        relayUrl: options.config.url,
        rid,
        identity,
        localBaseUrl: options.localBaseUrl ?? 'http://daemon.local',
        dispatch: options.dispatch,
        ...(options.webSocketImpl ? { webSocketImpl: options.webSocketImpl } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.onStatusChange ? { onStatusChange: options.onStatusChange } : {}),
      });
      registration.start();
    },
    stop(): void {
      registration?.stop();
      registration = null;
    },
    get status(): RelayRegistrationStatus | 'disabled' {
      return enabled ? (registration?.status ?? 'idle') : 'disabled';
    },
    async mintPairing(): Promise<RelayPairingPayload | null> {
      if (!registration) return null;
      return registration.mintPairing(options.config.label || undefined);
    },
  };
}
