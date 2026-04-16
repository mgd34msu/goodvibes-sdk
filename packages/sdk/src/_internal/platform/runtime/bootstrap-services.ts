import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { RuntimeEventBus } from './events/index.js';
import type { RuntimeServices } from './services.js';
import { DaemonServer } from '../daemon/server.js';
import { HttpListener } from '../daemon/http-listener.js';
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

export interface HostServicesHandle {
  readonly daemonServer: DaemonService | null;
  readonly httpListener: HttpListenerService | null;
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
      }),
    ]);
    if (result === 'timed_out') {
      logger.warn(`${label} startup timed out; continuing without it in this host instance`, { timeoutMs });
      if (cleanup) {
        void cleanup().catch((error) => {
          logger.warn(`${label} cleanup after startup timeout failed`, { error: summarizeError(error) });
        });
        void startPromise.then(() => cleanup()).catch(() => {});
      }
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function startHostServices(
  config: HostServicesConfig,
  runtimeBus: RuntimeEventBus,
  hookDispatcher: HookDispatcher,
  factories: ServiceFactories = {},
  runtimeServices: RuntimeServices,
): Promise<HostServicesHandle> {
  const sharedUserAuth = runtimeServices.localUserAuthManager;
  const createDaemonServer = factories.createDaemonServer ?? ((bus, userAuth, services): DaemonService =>
    new DaemonServer({ runtimeBus: bus, userAuth, runtimeServices: services }));
  const createHttpListener = factories.createHttpListener ?? ((dispatcher, userAuth, configManager): HttpListenerService =>
    new HttpListener({ hookDispatcher: dispatcher, userAuth, configManager }));
  const startupTimeoutMs = factories.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  const daemonHost = String(config.get('controlPlane.host') ?? '127.0.0.1');
  const daemonPort = Number(config.get('controlPlane.port') ?? 3421);
  const httpListenerHost = String(config.get('httpListener.host') ?? '127.0.0.1');
  const httpListenerPort = Number(config.get('httpListener.port') ?? 3422);
  const probeDaemonPortInUse = factories.probeDaemonPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));
  const probeHttpListenerPortInUse = factories.probeHttpListenerPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));

  let daemonServer: DaemonService | null = null;
  let httpListener: HttpListenerService | null = null;

  if (config.get('danger.daemon') as boolean) {
    if (await probeDaemonPortInUse(daemonHost, daemonPort)) {
      logger.warn('Daemon server port already in use; continuing without local daemon in this host instance', {
        host: daemonHost,
        port: daemonPort,
      });
    } else {
      daemonServer = createDaemonServer(runtimeBus, sharedUserAuth, runtimeServices);
      daemonServer.enable({ daemon: true }, factories.sharedDaemonToken);
      try {
        const service = daemonServer;
        const result = await startWithTimeout('Daemon server', () => service.start(), startupTimeoutMs, () => service.stop());
        if (result === 'timed_out') {
          daemonServer = null;
        }
      } catch (error) {
        const message = summarizeError(error);
        if (message.includes('EADDRINUSE') || message.includes('Address already in use')) {
          logger.warn('Daemon server port already in use; continuing without local daemon in this host instance', { error: message });
          daemonServer = null;
        } else {
          throw error;
        }
      }
    }
  }

  if (config.get('danger.httpListener') as boolean) {
    if (await probeHttpListenerPortInUse(httpListenerHost, httpListenerPort)) {
      logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', {
        host: httpListenerHost,
        port: httpListenerPort,
      });
    } else {
      httpListener = createHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager);
      httpListener.enable({ httpListener: true }, factories.sharedHttpListenerToken);
      try {
        const service = httpListener;
        const result = await startWithTimeout('HTTP listener', () => service.start(), startupTimeoutMs, () => service.stop());
        if (result === 'timed_out') {
          httpListener = null;
        }
      } catch (error) {
        const message = summarizeError(error);
        if (message.includes('EADDRINUSE') || message.includes('Address already in use')) {
          logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', { error: message });
          httpListener = null;
        } else {
          throw error;
        }
      }
    }
  }

  return {
    daemonServer,
    httpListener,
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

export type ExternalServicesHandle = HostServicesHandle;
export type ExternalServicesConfig = HostServicesConfig;
export const startExternalServices = startHostServices;
