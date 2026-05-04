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
