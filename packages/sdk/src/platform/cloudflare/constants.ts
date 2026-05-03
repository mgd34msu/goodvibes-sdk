import type { CloudflareComponent } from './types.js';

export const DEFAULT_WORKER_NAME = 'goodvibes-batch-worker';
export const DEFAULT_QUEUE_NAME = 'goodvibes-batch';
export const DEFAULT_DLQ_NAME = 'goodvibes-batch-dlq';
export const DEFAULT_WORKER_CRON = '*/5 * * * *';
export const DEFAULT_TUNNEL_NAME = 'goodvibes-daemon';
export const DEFAULT_KV_NAMESPACE_NAME = 'goodvibes-runtime';
export const DEFAULT_DO_NAMESPACE_NAME = 'GoodVibesCoordinator';
export const DEFAULT_R2_BUCKET_NAME = 'goodvibes-artifacts';
export const DEFAULT_SECRETS_STORE_NAME = 'goodvibes';
export const CLOUDFLARE_API_TOKEN_KEY = 'CLOUDFLARE_API_TOKEN';
export const CLOUDFLARE_TUNNEL_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN';
export const CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_ACCESS_SERVICE_TOKEN';
export const CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_WORKER_TOKEN';
export const CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_OPERATOR_TOKEN';

export const COMPONENT_ORDER: readonly CloudflareComponent[] = [
  'workers',
  'queues',
  'zeroTrustTunnel',
  'zeroTrustAccess',
  'dns',
  'kv',
  'durableObjects',
  'secretsStore',
  'r2',
];

export const DEFAULT_COMPONENTS: Readonly<Record<CloudflareComponent, boolean>> = {
  workers: true,
  queues: true,
  zeroTrustTunnel: false,
  zeroTrustAccess: false,
  dns: false,
  kv: false,
  durableObjects: false,
  secretsStore: false,
  r2: false,
};
