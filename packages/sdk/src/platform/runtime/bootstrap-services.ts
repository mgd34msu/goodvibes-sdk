import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { RuntimeEventBus } from './events/index.js';
import type { RuntimeServices } from './services.js';
import { ConfigurationError } from '@pellux/goodvibes-errors';
import { logger } from '../utils/logger.js';
import net from 'node:net';
import { summarizeError } from '../utils/error-display.js';

interface DaemonService {
  enable(config: { daemon: boolean }, token?: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  listRecentControlPlaneEvents(limit: number): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[];
}

interface HttpListenerService {
  enable(config: { httpListener: boolean }, token?: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ServiceFactories {
  createDaemonServer?: (
    runtimeBus: RuntimeEventBus,
    userAuth: RuntimeServices['localUserAuthManager'],
    runtimeServices: RuntimeServices,
  ) => DaemonService;
  createHttpListener?: (
    hookDispatcher: HookDispatcher,
    userAuth: RuntimeServices['localUserAuthManager'],
    configManager: RuntimeServices['configManager'],
  ) => HttpListenerService;
  startupTimeoutMs?: number;
  probeDaemonPortInUse?: (host: string, port: number) => Promise<boolean>;
  probeDaemonIdentity?: (
    host: string,
    port: number,
    token?: string,
  ) => Promise<DaemonIdentityProbeResult>;
  probeHttpListenerPortInUse?: (host: string, port: number) => Promise<boolean>;
  /**
   * Shared bearer token the daemon should accept on inbound HTTP requests.
   * When set, `daemon.enable()` registers this token and requests carrying
   * `Authorization: Bearer <token>` authenticate without a login session.
   * Surfaces that generate companion-app pairing tokens should pass the token
   * here so the embedded daemon accepts scanned QR credentials.
   */
  sharedDaemonToken?: string;
  /**
   * Shared bearer token for the HTTP listener (webhook-style surfaces).
   * Independent from `sharedDaemonToken`; different surfaces may issue
   * different tokens, or both may share the same bearer.
   */
  sharedHttpListenerToken?: string;
}

export type HostServiceMode = 'disabled' | 'embedded' | 'external' | 'blocked' | 'unavailable';

export interface HostServiceStatus {
  readonly mode: HostServiceMode;
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly reason?: string;
  readonly status?: string;
  readonly version?: string;
  readonly authenticated?: boolean;
}

interface DaemonIdentityProbeResult {
  readonly kind: 'goodvibes' | 'unauthorized' | 'unknown';
  readonly status?: string;
  readonly version?: string;
  readonly reason?: string;
}

export interface HostServicesHandle {
  readonly daemonServer: DaemonService | null;
  readonly httpListener: HttpListenerService | null;
  readonly daemonStatus: HostServiceStatus;
  readonly httpListenerStatus: HostServiceStatus;
  listRecentControlPlaneEvents(limit: number): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[];
  stop(): Promise<void>;
}

export interface HostServicesConfig {
  get(
    key:
      | 'danger.daemon'
      | 'danger.httpListener'
      | 'controlPlane.host'
      | 'controlPlane.port'
      | 'httpListener.host'
      | 'httpListener.port',
  ): boolean | string | number;
}
const DEFAULT_SERVICE_START_TIMEOUT_MS = 1500;

interface StartableService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function readBooleanSetting(config: HostServicesConfig, key: 'danger.daemon' | 'danger.httpListener'): boolean {
  const value = config.get(key);
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`Expected ${key} to be a boolean, got ${typeof value}.`);
  }
  return value;
}

function readHostSetting(
  config: HostServicesConfig,
  key: 'controlPlane.host' | 'httpListener.host',
  fallback: string,
): string {
  const value = config.get(key);
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new ConfigurationError(`Expected ${key} to be a host string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConfigurationError(`Expected ${key} to be a non-empty host string.`);
  }
  return trimmed;
}

function readPortSetting(
  config: HostServicesConfig,
  key: 'controlPlane.port' | 'httpListener.port',
  fallback: number,
): number {
  const value = config.get(key);
  if (value === undefined || value === null) return fallback;
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`Expected ${key} to be an integer TCP port between 1 and 65535.`);
  }
  return port;
}

function isBindConflictMessage(message: string): boolean {
  return message.includes('EADDRINUSE') || message.includes('Address already in use');
}

async function stopAfterFailedStart(label: string, service: StartableService): Promise<void> {
  try {
    await service.stop();
  } catch (error) {
    logger.warn(`${label} cleanup after failed startup failed`, { error: summarizeError(error) });
  }
}

async function startGuardedService<TService extends StartableService>(options: {
  readonly label: string;
  readonly service: TService;
  readonly timeoutMs: number;
  readonly startedStatus: () => HostServiceStatus;
  readonly timedOutStatus: () => HostServiceStatus;
  readonly bindConflictStatus: (message: string) => Promise<HostServiceStatus> | HostServiceStatus;
}): Promise<{ readonly service: TService | null; readonly status: HostServiceStatus }> {
  try {
    const result = await startWithTimeout(
      options.label,
      () => options.service.start(),
      options.timeoutMs,
      () => options.service.stop(),
    );
    if (result === 'timed_out') {
      return { service: null, status: options.timedOutStatus() };
    }
    return { service: options.service, status: options.startedStatus() };
  } catch (error) {
    const message = summarizeError(error);
    if (!isBindConflictMessage(message)) throw error;
    await stopAfterFailedStart(options.label, options.service);
    return { service: null, status: await options.bindConflictStatus(message) };
  }
}

async function isTcpPortInUse(host: string, port: number, timeoutMs = 250): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function normalizeProbeHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

function formatBaseUrl(host: string, port: number): string {
  const normalized = normalizeProbeHost(host);
  const urlHost = normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
  return `http://${urlHost}:${port}`;
}

function createServiceStatus(
  mode: HostServiceMode,
  host: string,
  port: number,
  details: Omit<HostServiceStatus, 'mode' | 'host' | 'port' | 'baseUrl'> = {},
): HostServiceStatus {
  return {
    mode,
    host,
    port,
    baseUrl: formatBaseUrl(host, port),
    ...details,
  };
}

async function probeGoodVibesDaemonIdentity(
  host: string,
  port: number,
  token?: string,
): Promise<DaemonIdentityProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  timeout.unref?.();
  try {
    const headers = new Headers();
    if (token?.trim()) headers.set('Authorization', `Bearer ${token.trim()}`);
    const response = await fetch(`${formatBaseUrl(host, port)}/status`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'unauthorized',
        reason: token?.trim()
          ? 'GoodVibes daemon identity probe was rejected by the configured token'
          : 'GoodVibes daemon identity probe needs an auth token',
      };
    }
    if (!response.ok) {
      return { kind: 'unknown', reason: `Identity probe returned HTTP ${response.status}` };
    }
    let body: { status?: unknown; version?: unknown } | null = null;
    try {
      body = await response.json() as { status?: unknown; version?: unknown };
    } catch (error) {
      return {
        kind: 'unknown',
        reason: `Identity probe response was not valid JSON: ${summarizeError(error)}`,
      };
    }
    if (body?.status === 'running' && typeof body.version === 'string') {
      return { kind: 'goodvibes', status: body.status, version: body.version };
    }
    return { kind: 'unknown', reason: 'Identity probe response did not match GoodVibes daemon status shape' };
  } catch (error) {
    return { kind: 'unknown', reason: summarizeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function startWithTimeout(
  label: string,
  start: () => Promise<void>,
  timeoutMs: number,
  cleanup?: () => Promise<void>,
): Promise<'started' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startPromise = start().then(() => 'started' as const);
  try {
    const result = await Promise.race([
      startPromise,
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === 'timed_out') {
      logger.warn(`${label} startup timed out; continuing without it in this host instance`, { timeoutMs });
      if (cleanup) {
        void cleanup().catch((error) => {
          logger.warn(`${label} cleanup after startup timeout failed`, { error: summarizeError(error) });
        });
        void startPromise.then(
          async () => {
            try {
              await cleanup();
            } catch (error) {
              logger.warn(`${label} delayed cleanup after startup timeout failed`, { error: summarizeError(error) });
            }
          },
          (error) => {
            logger.warn(`${label} startup rejected after timeout`, { error: summarizeError(error) });
          },
        );
      }
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function createDefaultDaemonServer(
  runtimeBus: RuntimeEventBus,
  userAuth: RuntimeServices['localUserAuthManager'],
  runtimeServices: RuntimeServices,
): Promise<DaemonService> {
  const { DaemonServer } = await import('../daemon/server.js');
  return new DaemonServer({ runtimeBus, userAuth, runtimeServices });
}

async function createDefaultHttpListener(
  hookDispatcher: HookDispatcher,
  userAuth: RuntimeServices['localUserAuthManager'],
  configManager: RuntimeServices['configManager'],
): Promise<HttpListenerService> {
  const { HttpListener } = await import('../daemon/http-listener.js');
  return new HttpListener({ hookDispatcher, userAuth, configManager });
}

export async function startHostServices(
  config: HostServicesConfig,
  runtimeBus: RuntimeEventBus,
  hookDispatcher: HookDispatcher,
  runtimeServices: RuntimeServices,
  factories: ServiceFactories = {},
): Promise<HostServicesHandle> {
  const sharedUserAuth = runtimeServices.localUserAuthManager;
  const startupTimeoutMs = factories.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  const daemonHost = readHostSetting(config, 'controlPlane.host', '127.0.0.1');
  const daemonPort = readPortSetting(config, 'controlPlane.port', 3421);
  const httpListenerHost = readHostSetting(config, 'httpListener.host', '127.0.0.1');
  const httpListenerPort = readPortSetting(config, 'httpListener.port', 3422);
  const probeDaemonPortInUse = factories.probeDaemonPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));
  const probeDaemonIdentity = factories.probeDaemonIdentity ?? probeGoodVibesDaemonIdentity;
  const probeHttpListenerPortInUse = factories.probeHttpListenerPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));

  let daemonServer: DaemonService | null = null;
  let httpListener: HttpListenerService | null = null;
  let daemonStatus = createServiceStatus('disabled', daemonHost, daemonPort, { reason: 'danger.daemon is disabled' });
  let httpListenerStatus = createServiceStatus('disabled', httpListenerHost, httpListenerPort, {
    reason: 'danger.httpListener is disabled',
  });

  if (readBooleanSetting(config, 'danger.daemon')) {
    if (await probeDaemonPortInUse(daemonHost, daemonPort)) {
      const identity = await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken);
      if (identity.kind === 'goodvibes') {
        daemonStatus = createServiceStatus('external', daemonHost, daemonPort, {
          authenticated: true,
          status: identity.status,
          version: identity.version,
          reason: 'Existing GoodVibes daemon verified on configured host/port',
        });
        logger.info('Existing GoodVibes daemon detected; continuing without embedded daemon in this host instance', {
          host: daemonHost,
          port: daemonPort,
          version: identity.version,
        });
      } else {
        daemonStatus = createServiceStatus('blocked', daemonHost, daemonPort, {
          authenticated: identity.kind !== 'unauthorized' ? undefined : false,
          reason: identity.reason ?? 'Configured daemon port is occupied by an unverified process',
        });
        logger.warn(
          'Daemon server port already in use by an unverified process; continuing without embedded daemon in this host instance',
          {
            host: daemonHost,
            port: daemonPort,
            reason: identity.reason,
          },
        );
      }
    } else {
      daemonServer = factories.createDaemonServer
        ? factories.createDaemonServer(runtimeBus, sharedUserAuth, runtimeServices)
        : await createDefaultDaemonServer(runtimeBus, sharedUserAuth, runtimeServices);
      const service = daemonServer;
      service.enable({ daemon: true }, factories.sharedDaemonToken);
      const started = await startGuardedService({
        label: 'Daemon server',
        service,
        timeoutMs: startupTimeoutMs,
        timedOutStatus: () => createServiceStatus('unavailable', daemonHost, daemonPort, {
          reason: 'Daemon server startup timed out',
        }),
        startedStatus: () => createServiceStatus('embedded', daemonHost, daemonPort, {
          reason: 'Embedded daemon started in this host instance',
        }),
        bindConflictStatus: async (message) => {
          const identity = await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken);
          if (identity.kind === 'goodvibes') {
            logger.info(
              'Existing GoodVibes daemon detected after bind conflict; continuing without embedded daemon in this host instance',
              {
                host: daemonHost,
                port: daemonPort,
                version: identity.version,
              },
            );
            return createServiceStatus('external', daemonHost, daemonPort, {
              authenticated: true,
              status: identity.status,
              version: identity.version,
              reason: 'Existing GoodVibes daemon verified after bind conflict',
            });
          }
          logger.warn('Daemon server port already in use; continuing without local daemon in this host instance', { error: message });
          return createServiceStatus('blocked', daemonHost, daemonPort, {
            authenticated: identity.kind !== 'unauthorized' ? undefined : false,
            reason: identity.reason ?? message,
          });
        },
      });
      daemonServer = started.service;
      daemonStatus = started.status;
    }
  }

  if (readBooleanSetting(config, 'danger.httpListener')) {
    if (await probeHttpListenerPortInUse(httpListenerHost, httpListenerPort)) {
      httpListenerStatus = createServiceStatus('blocked', httpListenerHost, httpListenerPort, {
        reason: 'Configured HTTP listener port is already in use',
      });
      logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', {
        host: httpListenerHost,
        port: httpListenerPort,
      });
    } else {
      httpListener = factories.createHttpListener
        ? factories.createHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager)
        : await createDefaultHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager);
      const service = httpListener;
      service.enable({ httpListener: true }, factories.sharedHttpListenerToken);
      const started = await startGuardedService({
        label: 'HTTP listener',
        service,
        timeoutMs: startupTimeoutMs,
        timedOutStatus: () => createServiceStatus('unavailable', httpListenerHost, httpListenerPort, {
          reason: 'HTTP listener startup timed out',
        }),
        startedStatus: () => createServiceStatus('embedded', httpListenerHost, httpListenerPort, {
          reason: 'Embedded HTTP listener started in this host instance',
        }),
        bindConflictStatus: (message) => {
          logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', { error: message });
          return createServiceStatus('blocked', httpListenerHost, httpListenerPort, { reason: message });
        },
      });
      httpListener = started.service;
      httpListenerStatus = started.status;
    }
  }

  return {
    daemonServer,
    httpListener,
    daemonStatus,
    httpListenerStatus,
    listRecentControlPlaneEvents(limit: number): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[] {
      return daemonServer?.listRecentControlPlaneEvents(limit) ?? [];
    },
    async stop(): Promise<void> {
      await Promise.allSettled([
        daemonServer?.stop(),
        httpListener?.stop(),
      ]);
    },
  };
}
