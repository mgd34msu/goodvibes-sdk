export type DaemonErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'permission'
  | 'tool'
  | 'config'
  | 'protocol'
  | 'service'
  | 'internal'
  | 'unknown';

export const DaemonErrorCategory = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  BILLING: 'billing',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  PERMISSION: 'permission',
  TOOL: 'tool',
  CONFIG: 'config',
  PROTOCOL: 'protocol',
  SERVICE: 'service',
  INTERNAL: 'internal',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, DaemonErrorCategory>;

export type DaemonErrorSource =
  | 'provider'
  | 'tool'
  | 'transport'
  | 'config'
  | 'permission'
  | 'runtime'
  | 'render'
  | 'acp'
  | 'unknown';

/**
 * The `code` a memory route sets on a 404 whose body means "the addressed RECORD
 * does not exist" — the route ran, the store simply had no such id. This is the
 * ONE 404 disposition a memory wire consumer may fold to `null` ("no such
 * record").
 *
 * It exists to be distinguishable from a route-not-found 404: an older daemon
 * that never registered an extended memory route answers the terminal 404 with
 * `code: 'NOT_FOUND'` (see the daemon HTTP router's final fallthrough), NOT this
 * code. That difference is the runtime signal the memory-spine wire discriminator
 * keys on — a `MEMORY_RECORD_NOT_FOUND` 404 is a genuine record-miss (→ null),
 * while ANY other 404 (route-not-found, or a bare legacy 404 with no code) means
 * "this daemon does not serve this verb" and must reject honestly, never silently
 * null. Emitted by daemon-sdk's memory record handlers; consumed by the
 * memory-spine wire discriminator.
 */
export const MEMORY_RECORD_NOT_FOUND_CODE = 'MEMORY_RECORD_NOT_FOUND';

export interface StructuredDaemonErrorBody {
  readonly error: string;
  readonly hint?: string | undefined;
  readonly code?: string | undefined;
  readonly category?: DaemonErrorCategory | undefined;
  readonly source?: DaemonErrorSource | undefined;
  readonly recoverable?: boolean | undefined;
  readonly status?: number | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}
