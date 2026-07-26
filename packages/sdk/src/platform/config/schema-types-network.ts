/**
 * Listener / reachability config interfaces: where the daemon binds
 * (control plane, generic HTTP listener, web surface), how outbound TLS and
 * remote fetch behave, and the outbound relay. Split out of schema-types.ts so
 * that file stays under its grandfathered line ceiling; re-exported from
 * schema-types.ts so import sites are unchanged.
 */
export interface ControlPlaneConfig {
  enabled: boolean;
  /**
   * The shared gateway/control-plane host (state snapshots, live streams,
   * authenticated control APIs). Default true: a stock daemon can stream
   * companion chat; turn off for a request/response-only daemon.
   */
  gateway: boolean;
  hostMode: 'local' | 'network' | 'custom';
  host: string;
  port: number;
  /**
   * An OVERRIDE for a genuinely external address — a tunnel or reverse proxy
   * whose public address the bind cannot describe. Empty by default, and empty
   * is the normal state: the everyday base URL is DERIVED from
   * `hostMode`/`host`/`port`/`tls.mode` by `deriveControlPlaneBaseUrl`, so it
   * cannot go stale.
   *
   * This is deliberately not a mirror of the bind. The removed `baseUrl` key
   * was one, had no writers, and drifted on three axes at once (port, scheme,
   * and a hand-set host passed through verbatim) — set this ONLY when an
   * off-box address genuinely differs from where the daemon listens.
   */
  publicBaseUrl: string;
  streamMode: 'sse' | 'websocket' | 'both';
  allowRemote: boolean;
  trustProxy: boolean;
  openaiCompatible: {
    enabled: boolean;
    pathPrefix: string;
  };
  webui: {
    serve: boolean;
    bundleDir: string;
  };
  cors: {
    enabled: boolean;
    allowedOrigins: string;
  };
  tls: {
    mode: 'off' | 'proxy' | 'direct';
    certFile: string;
    keyFile: string;
  };
}

export interface HttpListenerRuntimeConfig {
  hostMode: 'local' | 'network' | 'custom';
  host: string;
  port: number;
  trustProxy: boolean;
  tls: {
    mode: 'off' | 'proxy' | 'direct';
    certFile: string;
    keyFile: string;
  };
}

export interface WebConfig {
  enabled: boolean;
  hostMode: 'local' | 'network' | 'custom';
  host: string;
  port: number;
  publicBaseUrl: string;
  staticAssetsDir: string;
}

export interface NetworkConfig {
  outboundTls: {
    mode: 'bundled' | 'bundled+custom' | 'custom';
    customCaFile: string;
    customCaDir: string;
    allowInsecureLocalhost: boolean;
  };
  remoteFetch: {
    allowPrivateHosts: boolean;
  };
}

/**
 * Outbound relay reachability. When enabled, the daemon connects OUTBOUND to a
 * self-hostable, zero-knowledge relay and registers under an unguessable
 * rendezvous id so surfaces can reach it from outside the LAN. The relay never
 * sees plaintext — an end-to-end channel terminates inside the daemon.
 * `relay.enabled` defaults ON, but no connection is ever made without an
 * explicitly configured `relay.url` — leave it empty to stay LAN-only.
 */
export interface RelayConfig {
  enabled: boolean;
  /** Relay URL to dial (wss://…). Empty disables the outbound connection. */
  url: string;
  /** Stable unguessable rendezvous id; generated on first enable when empty. */
  rendezvousId: string;
  /** Human-facing daemon label carried in pairing payloads. */
  label: string;
  /** Require a recent WebAuthn step-up assertion on mutating relay calls (fails closed until a verifier is wired). */
  requireStepUpForMutations: boolean;
}
