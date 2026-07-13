import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { RuntimeEventBus } from './events/index.js';
import type { RuntimeServices } from './services.js';
import { ConfigurationError } from '@pellux/goodvibes-errors';
import { logger } from '../utils/logger.js';
import net from 'node:net';
import os from 'node:os';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { summarizeError } from '../utils/error-display.js';
import { createTimeoutController } from '../utils/fetch-with-timeout.js';
import { VERSION } from '../version.js';
import { isDaemonVersionCompatible, describeVersionIncompatibility } from './daemon-version-compat.js';
import { resolveDaemonEnabled } from '../config/index.js';
import { recordDetachedDaemonRuntime } from './detached-daemon-runtime.js';
import {
  classifyDaemonProbe,
  decideDaemonAdoption,
  type DaemonIdentityProbeResult,
} from './daemon-adoption-policy.js';

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

/**
 * Options passed to the injectable detached-daemon spawn seam. Mirrors the subset
 * of `child_process.SpawnOptions` the detached spawn relies on. `detached: true`
 * and the caller's subsequent `unref()` are what let the daemon outlive this
 * surface — tests assert both are present.
 */
export interface DetachedDaemonSpawnOptions {
  readonly detached: boolean;
  readonly stdio: 'ignore' | ReadonlyArray<'ignore' | number>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Minimal child-process shape the detached spawn seam must return. */
export interface DetachedDaemonChild {
  readonly pid?: number | undefined;
  unref(): void;
  once?(event: 'error' | 'exit', listener: (arg: unknown) => void): void;
}

/**
 * One-time hint surfaced ONCE by the TUI after a successful detached spawn.
 * The daemon promotes itself to a supervised service at its first idle
 * moment when a service manager is available (see the facade lifecycle's
 * boot promotion), so this mostly narrates what happens on its own; where
 * promotion is not possible, it names the one-command path — never a raw
 * HTTP instruction.
 */
export const DETACHED_DAEMON_INSTALL_HINT =
  'daemon started for this session — it installs itself as a system service at its first idle moment when the platform supports it; if it stays session-only, run: goodvibes-daemon --install-service';

interface ServiceFactories {
  createDaemonServer?: (
    runtimeBus: RuntimeEventBus,
    userAuth: RuntimeServices['localUserAuthManager'],
    runtimeServices: RuntimeServices,
  ) => DaemonService;
  /**
   * Injectable spawn seam for the detached standalone daemon (Layer 2 default).
   * Defaults to `child_process.spawn`. Tests stub this to assert that detached
   * spawn — not in-process embedding — is chosen by default, and that the options
   * carry `detached: true` (the caller then `unref()`s the returned child).
   */
  spawnDetachedDaemon?: (
    command: string,
    args: readonly string[],
    options: DetachedDaemonSpawnOptions,
  ) => DetachedDaemonChild;
  /** Command used to launch the detached daemon. Default: `GOODVIBES_DAEMON_BINARY` env or `goodvibes-daemon`. */
  daemonLaunchCommand?: string | undefined;
  /** Extra CLI args appended after the resolved `--daemon-home/--hostname/--port` flags. */
  daemonLaunchArgs?: readonly string[] | undefined;
  /** Daemon home directory passed via `--daemon-home`. Default: `os.homedir()`. */
  daemonHomeDir?: string | undefined;
  /** Directory where the detached daemon records pid/port + log. Default `<daemonHomeDir>/.goodvibes/daemon`. */
  daemonRuntimeDir?: string | undefined;
  /** Bounded time to wait for the detached daemon to bind + pass the identity probe. */
  detachedSpawnProbeTimeoutMs?: number | undefined;
  /** Poll interval while waiting for the detached daemon to become reachable. */
  detachedSpawnProbeIntervalMs?: number | undefined;
  /** Sleep function (injectable so tests drive the probe loop deterministically). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  createHttpListener?: (
    hookDispatcher: HookDispatcher,
    userAuth: RuntimeServices['localUserAuthManager'],
    configManager: RuntimeServices['configManager'],
  ) => HttpListenerService;
  startupTimeoutMs?: number | undefined;
  probeDaemonPortInUse?: ((host: string, port: number) => Promise<boolean>) | undefined;
  probeDaemonIdentity?: (
    host: string,
    port: number,
    token?: string,
  ) => Promise<DaemonIdentityProbeResult>;
  probeHttpListenerPortInUse?: ((host: string, port: number) => Promise<boolean>) | undefined;
  /**
   * Shared bearer token the daemon should accept on inbound HTTP requests.
   * When set, `daemon.enable()` registers this token and requests carrying
   * `Authorization: Bearer <token>` authenticate without a login session.
   * Surfaces that generate companion-app pairing tokens should pass the token
   * here so the embedded daemon accepts scanned QR credentials.
   */
  sharedDaemonToken?: string | undefined;
  /**
   * Shared bearer token for the HTTP listener (webhook-style surfaces).
   * Independent from `sharedDaemonToken`; different surfaces may issue
   * different tokens, or both may share the same bearer.
   */
  sharedHttpListenerToken?: string | undefined;
  /**
   * This surface's own SDK version, used to band-check a daemon found on the
   * configured port before adopting it. Defaults to the SDK `VERSION`. Injected
   * mainly so tests can drive the compatibility gate deterministically.
   */
  localDaemonVersion?: string | undefined;
  /**
   * Override for the version-compatibility predicate. Defaults to the shared
   * `isDaemonVersionCompatible` band policy. Tests inject a stub to exercise the
   * incompatible-adoption refusal without constructing skewed daemons.
   */
  isDaemonVersionCompatible?: ((localVersion: string, remoteVersion: string | undefined) => boolean) | undefined;
  /**
   * Adopt-only policy: attach to a compatible running daemon but NEVER spawn or
   * embed one when the port is free. Expresses the "this surface does not own the
   * daemon lifecycle" stance (e.g. the agent connecting to an externally-owned
   * host) as configuration rather than a wholesale override of this function.
   * The version band-check still applies before adopting. Default false.
   */
  adoptOnly?: boolean | undefined;
}

export type HostServiceMode = 'disabled' | 'embedded' | 'external' | 'blocked' | 'incompatible' | 'unavailable';

export interface HostServiceStatus {
  readonly mode: HostServiceMode;
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly reason?: string | undefined;
  readonly status?: string | undefined;
  readonly version?: string | undefined;
  readonly authenticated?: boolean | undefined;
}

export interface HostServicesHandle {
  readonly daemonServer: DaemonService | null;
  readonly httpListener: HttpListenerService | null;
  readonly daemonStatus: HostServiceStatus;
  readonly httpListenerStatus: HostServiceStatus;
  /**
   * One-time, honest hint the surface can display ONCE after this host instance
   * spawned a detached daemon for the session. Present only when a detached
   * daemon was just started (Layer 2); undefined when a daemon was adopted,
   * embedded, disabled, or unavailable. See {@link DETACHED_DAEMON_INSTALL_HINT}.
   */
  readonly daemonStartHint?: string | undefined;
  listRecentControlPlaneEvents(limit: number): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[];
  stop(): Promise<void>;
}

export interface HostServicesConfig {
  get(
    key:
      | 'daemon.enabled'
      | 'daemon.embedInProcess'
      | 'danger.httpListener'
      | 'controlPlane.host'
      | 'controlPlane.port'
      | 'httpListener.host'
      | 'httpListener.port',
  ): boolean | string | number | undefined;
}
const DEFAULT_SERVICE_START_TIMEOUT_MS = 1500;
const TCP_PORT_PROBE_TIMEOUT_MS = 250;
const DAEMON_IDENTITY_PROBE_TIMEOUT_MS = 750;

interface StartableService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function readBooleanSetting(config: HostServicesConfig, key: 'danger.httpListener'): boolean {
  const value = config.get(key);
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`Expected ${key} to be a boolean, got ${typeof value}.`);
  }
  return value;
}

/**
 * Whether the daemon should be hosted IN THIS PROCESS (Layer 3 opt-in). Default
 * false: the surface spawns a detached daemon instead. Reads leniently so an
 * unset value (undefined) means false rather than throwing.
 */
function readDaemonEmbedInProcess(config: HostServicesConfig): boolean {
  return config.get('daemon.embedInProcess') === true;
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

async function isTcpPortInUse(host: string, port: number, timeoutMs = TCP_PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
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
  const { signal, dispose } = createTimeoutController(DAEMON_IDENTITY_PROBE_TIMEOUT_MS);
  try {
    const headers = new Headers();
    if (token?.trim()) headers.set('Authorization', `Bearer ${token.trim()}`);
    const response = await fetch(`${formatBaseUrl(host, port)}/status`, {
      headers,
      signal,
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
    dispose();
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
  const localDaemonVersion = factories.localDaemonVersion ?? VERSION;
  const versionCompatible = factories.isDaemonVersionCompatible ?? isDaemonVersionCompatible;

  // A daemon whose identity probe says `goodvibes` has only proven it IS a
  // GoodVibes daemon — not that it speaks a wire version this surface can adopt.
  // Band-check the reported version and produce an honest `incompatible` status
  // (never a second competing daemon) when it does not match this surface's band.
  const resolveVerifiedDaemonStatus = (
    identity: DaemonIdentityProbeResult,
    reasonAdopted: string,
  ): HostServiceStatus => {
    if (classifyDaemonProbe({ identity, localVersion: localDaemonVersion, versionCompatible }) === 'adopt') {
      return createServiceStatus('external', daemonHost, daemonPort, {
        authenticated: true,
        status: identity.status,
        version: identity.version,
        reason: reasonAdopted,
      });
    }
    const reason = describeVersionIncompatibility(daemonHost, daemonPort, localDaemonVersion, identity.version);
    logger.warn('Daemon on configured port reports an incompatible version; refusing to adopt or start a competing daemon', {
      host: daemonHost,
      port: daemonPort,
      foundVersion: identity.version,
      localVersion: localDaemonVersion,
    });
    return createServiceStatus('incompatible', daemonHost, daemonPort, {
      authenticated: true,
      status: identity.status,
      version: identity.version,
      reason,
    });
  };

  // Layer 2: spawn the daemon as a DETACHED standalone process (default), then
  // poll (bounded) for it to bind and pass the identity probe. On success adopt
  // it as 'external' with a one-time install-service hint. Returns an honest
  // failure reason otherwise so the caller can fall back.
  const attemptDetachedDaemonSpawn = async (): Promise<
    { readonly status: HostServiceStatus; readonly hint: string } | { readonly reason: string }
  > => {
    const spawnDetached: NonNullable<ServiceFactories['spawnDetachedDaemon']> =
      factories.spawnDetachedDaemon
      ?? ((command, args, options) => spawn(command, [...args], {
        detached: options.detached,
        stdio: options.stdio as SpawnOptions['stdio'],
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }) as unknown as DetachedDaemonChild);

    const command = (factories.daemonLaunchCommand ?? process.env.GOODVIBES_DAEMON_BINARY ?? 'goodvibes-daemon').trim()
      || 'goodvibes-daemon';
    const daemonHomeDir = factories.daemonHomeDir ?? os.homedir();
    const runtimeDir = factories.daemonRuntimeDir ?? join(daemonHomeDir, '.goodvibes', 'daemon');
    const logFilePath = join(runtimeDir, 'detached-daemon.log');
    const args = [
      '--daemon-home', daemonHomeDir,
      '--hostname', daemonHost,
      '--port', String(daemonPort),
      ...(factories.daemonLaunchArgs ?? []),
    ];

    let stdio: DetachedDaemonSpawnOptions['stdio'] = 'ignore';
    let closeStdio: (() => void) | null = null;
    try {
      mkdirSync(runtimeDir, { recursive: true });
      const out = openSync(logFilePath, 'a');
      const err = openSync(logFilePath, 'a');
      stdio = ['ignore', out, err];
      closeStdio = () => {
        try { closeSync(out); } catch { /* already closed */ }
        try { closeSync(err); } catch { /* already closed */ }
      };
    } catch {
      stdio = 'ignore';
    }

    let child: DetachedDaemonChild;
    try {
      child = spawnDetached(command, args, {
        detached: true,
        stdio,
        cwd: daemonHomeDir,
        env: { ...process.env, GOODVIBES_DAEMON_HOME: daemonHomeDir },
      });
    } catch (error) {
      return { reason: `Detached daemon spawn failed to launch: ${summarizeError(error)}` };
    } finally {
      // The child has inherited the fds; the parent's copies can be closed now.
      closeStdio?.();
    }
    child.unref();

    let processError: string | null = null;
    child.once?.('error', (err) => { processError = summarizeError(err); });

    recordDetachedDaemonRuntime(runtimeDir, {
      pid: child.pid,
      host: daemonHost,
      port: daemonPort,
      command,
      startedAt: new Date().toISOString(),
      logFilePath,
    });

    const timeoutMs = factories.detachedSpawnProbeTimeoutMs ?? 5000;
    const intervalMs = factories.detachedSpawnProbeIntervalMs ?? 150;
    const sleep = factories.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }));
    const deadline = Date.now() + timeoutMs;
    let lastReason = 'Detached daemon did not become reachable before timeout';
    // Probe at least once, then poll until the deadline.
    for (;;) {
      if (processError) return { reason: `Detached daemon process error: ${processError}` };
      const identity = await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken);
      if (identity.kind === 'goodvibes') {
        const verified = resolveVerifiedDaemonStatus(identity, 'Spawned detached daemon for this session');
        if (verified.mode === 'external') {
          return { status: verified, hint: DETACHED_DAEMON_INSTALL_HINT };
        }
        // Incompatible: do not keep a competing daemon around; report honestly.
        return { reason: verified.reason ?? 'Spawned daemon reported an incompatible version' };
      }
      lastReason = identity.reason ?? lastReason;
      if (Date.now() >= deadline) return { reason: lastReason };
      await sleep(intervalMs);
    }
  };

  let embeddedDaemonServer: DaemonService | null = null;
  let embeddedHttpListener: HttpListenerService | null = null;
  let daemonStartHint: string | undefined;
  let daemonStatus = createServiceStatus('disabled', daemonHost, daemonPort, { reason: 'daemon.enabled is false' });
  let httpListenerStatus = createServiceStatus('disabled', httpListenerHost, httpListenerPort, {
    reason: 'danger.httpListener is disabled',
  });

  if (resolveDaemonEnabled(config)) {
    // Port is free. Owner ruling (D7a): the daemon is a SYSTEM SERVICE, so
    // starting a surface must NOT couple the daemon's lifetime to this process.
    // DEFAULT (Layer 2): spawn the daemon as a detached standalone process and
    // adopt it as 'external'. In-process embedding is an explicit opt-in
    // (Layer 3: daemon.embedInProcess).
    const startEmbeddedDaemon = async (): Promise<{ readonly service: DaemonService | null; readonly status: HostServiceStatus }> => {
      const pendingDaemonServer = factories.createDaemonServer
        ? factories.createDaemonServer(runtimeBus, sharedUserAuth, runtimeServices)
        : await createDefaultDaemonServer(runtimeBus, sharedUserAuth, runtimeServices);
      const service = pendingDaemonServer;
      service.enable({ daemon: true }, factories.sharedDaemonToken);
      return startGuardedService({
        label: 'Daemon server',
        service,
        timeoutMs: startupTimeoutMs,
        timedOutStatus: () => createServiceStatus('unavailable', daemonHost, daemonPort, {
          reason: 'Daemon server startup timed out',
        }),
        startedStatus: () => createServiceStatus('embedded', daemonHost, daemonPort, {
          reason: 'Embedded daemon started in this host instance (daemon.embedInProcess opt-in)',
        }),
        bindConflictStatus: async (message) => {
          const identity = await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken);
          if (identity.kind === 'goodvibes') {
            const verified = resolveVerifiedDaemonStatus(identity, 'Existing GoodVibes daemon verified after bind conflict');
            if (verified.mode === 'external') {
              logger.info(
                'Existing GoodVibes daemon detected after bind conflict; continuing without embedded daemon in this host instance',
                { host: daemonHost, port: daemonPort, version: identity.version },
              );
            }
            return verified;
          }
          logger.warn('Daemon server port already in use; continuing without local daemon in this host instance', { error: message });
          return createServiceStatus('blocked', daemonHost, daemonPort, {
            authenticated: identity.kind !== 'unauthorized' ? undefined : false,
            reason: identity.reason ?? message,
          });
        },
      });
    };

    // ONE shared adopt-or-spawn decision (daemon-adoption-policy.ts). Probe the
    // port + identity, then map the pure ruling onto this surface's I/O. The
    // version band-check is inside the policy, applied before any adopt — the
    // agent's stub used to skip it; the adopt-only stance is now `factories.adoptOnly`.
    const portInUse = await probeDaemonPortInUse(daemonHost, daemonPort);
    const identity = portInUse
      ? await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken)
      : null;
    const decision = decideDaemonAdoption({
      enabled: true,
      portInUse,
      identity,
      localVersion: localDaemonVersion,
      versionCompatible,
      embedInProcess: readDaemonEmbedInProcess(config),
      adoptOnly: factories.adoptOnly === true,
    });

    switch (decision.action) {
      case 'adopt':
      case 'incompatible': {
        daemonStatus = resolveVerifiedDaemonStatus(decision.identity!, 'Existing GoodVibes daemon verified on configured host/port');
        if (daemonStatus.mode === 'external') {
          logger.info('Existing GoodVibes daemon detected; continuing without embedded daemon in this host instance', {
            host: daemonHost,
            port: daemonPort,
            version: decision.identity?.version,
          });
        }
        break;
      }
      case 'blocked': {
        daemonStatus = createServiceStatus('blocked', daemonHost, daemonPort, {
          authenticated: decision.identity?.kind !== 'unauthorized' ? undefined : false,
          reason: decision.identity?.reason ?? 'Configured daemon port is occupied by an unverified process',
        });
        logger.warn(
          'Daemon server port already in use by an unverified process; continuing without embedded daemon in this host instance',
          { host: daemonHost, port: daemonPort, reason: decision.identity?.reason },
        );
        break;
      }
      case 'adopt-only-idle': {
        daemonStatus = createServiceStatus('unavailable', daemonHost, daemonPort, { reason: decision.reason });
        logger.info('adopt-only policy: no daemon reachable on the configured host/port; running without a local daemon', {
          host: daemonHost,
          port: daemonPort,
        });
        break;
      }
      case 'embed': {
        logger.warn(
          'daemon.embedInProcess is enabled: hosting the daemon in-process couples its lifetime to this surface (single point of failure)',
        );
        const started = await startEmbeddedDaemon();
        embeddedDaemonServer = started.service;
        daemonStatus = started.status;
        break;
      }
      case 'spawn': {
        const detached = await attemptDetachedDaemonSpawn();
        if ('status' in detached) {
          daemonStatus = detached.status;
          daemonStartHint = detached.hint;
          logger.info('Spawned detached GoodVibes daemon for this session', {
            host: daemonHost,
            port: daemonPort,
            version: detached.status.version,
          });
        } else {
          logger.warn(
            'Detached daemon spawn did not become reachable; falling back to in-process embedded daemon for this session',
            { reason: detached.reason },
          );
          const started = await startEmbeddedDaemon();
          embeddedDaemonServer = started.service;
          daemonStatus = started.status;
        }
        break;
      }
      case 'disabled':
        break;
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
      const pendingHttpListener = factories.createHttpListener
        ? factories.createHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager)
        : await createDefaultHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager);
      const service = pendingHttpListener;
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
      embeddedHttpListener = started.service;
      httpListenerStatus = started.status;
    }
  }

  return {
    daemonServer: embeddedDaemonServer,
    httpListener: embeddedHttpListener,
    daemonStatus,
    httpListenerStatus,
    ...(daemonStartHint !== undefined ? { daemonStartHint } : {}),
    listRecentControlPlaneEvents(limit: number): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[] {
      return embeddedDaemonServer?.listRecentControlPlaneEvents(limit) ?? [];
    },
    async stop(): Promise<void> {
      await Promise.allSettled([
        embeddedDaemonServer?.stop(),
        embeddedHttpListener?.stop(),
      ]);
    },
  };
}
