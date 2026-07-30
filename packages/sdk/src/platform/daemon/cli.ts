import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../config/manager.js';
import { resolveDaemonEnabled } from '../config/index.js';
import { RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { createRuntimeServices } from '../runtime/services.js';
import { createHostPowerSeam } from '../power/runtime-wiring.js';
import { DaemonServer } from './server.js';
import { HttpListener } from './http-listener.js';
import { PlatformServiceManager } from './service-manager.js';
import { VERSION } from '../version.js';
import { configureActivityLogger, flushActivityLogSync, logger } from '../utils/logger.js';
import { GlobalNetworkTransportInstaller } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveDaemonHomeDir, ensureDaemonHome, readDaemonSetting } from '../workspace/daemon-home.js';
import { WorkspaceSwapManager } from '../workspace/workspace-swap-manager.js';

type DaemonCliOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly daemonHomeDir: string;
};

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

/**
 * Parse --daemon-home=<path> and --working-dir=<path> from process.argv.
 * Returns undefined when the flag is not present.
 */
function parseCliFlag(args: string[], flagPrefix: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(flagPrefix + '=')) return arg.slice(flagPrefix.length + 1);
    if (arg === flagPrefix) {
      const idx = args.indexOf(arg);
      return args[idx + 1];
    }
  }
  return undefined;
}

type DaemonCliPaths = DaemonCliOwnership;

/**
 * Resolves daemon home dir and working dir from CLI flags, env vars, and persisted settings.
 */
function resolveDaemonCliPaths(env: NodeJS.ProcessEnv = process.env): DaemonCliPaths {
  const daemonHomeArg = parseCliFlag(process.argv, '--daemon-home');
  const workingDirArg = parseCliFlag(process.argv, '--working-dir');

  const resolvedDaemonHomeDir = resolveDaemonHomeDir({ daemonHomeArg, env });

  // Working dir resolution: flag > env > daemon-settings.json persisted > cwd.
  const workingDirectory =
    workingDirArg ??
    env['GOODVIBES_WORKING_DIR'] ??
    readDaemonSetting(resolvedDaemonHomeDir, 'runtime.workingDir') ??
    process.cwd();

  return {
    workingDirectory,
    homeDirectory: homedir(),
    daemonHomeDir: resolvedDaemonHomeDir,
  };
}

function readDaemonCliTokens(env: NodeJS.ProcessEnv): DaemonCliTokens {
  const daemonToken = env.GOODVIBES_DAEMON_TOKEN;
  return {
    daemonToken,
    httpToken: env.GOODVIBES_HTTP_TOKEN ?? daemonToken,
  };
}

/**
 * The one-command service install: `goodvibes-daemon --install-service`
 * writes the service unit (with the survival contract) and reports the
 * follow-up commands — no raw HTTP call, no admin-token juggling. This is
 * what the detached-spawn hint names for setups where the daemon could not
 * promote itself.
 */
function installServiceAndExit(config: ConfigManager, workingDir: string, homeDirectory: string): never {
  const manager = new PlatformServiceManager(config, {
    workingDirectory: workingDir,
    homeDirectory,
    surfaceRoot: 'goodvibes',
    binaryBaseName: 'goodvibes',
    defaultServiceName: 'goodvibes',
    defaultServiceDescription: 'goodvibes omnichannel daemon host',
  });
  try {
    const result = manager.install();
    process.stdout.write(`service unit installed: ${result.path} (${result.serviceName}, ${result.platform})\n`);
    for (const command of result.suggestedCommands) process.stdout.write(`  next: ${command}\n`);
    if (result.lingerNote) process.stdout.write(`${result.lingerNote}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`service install failed: ${summarizeError(error)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { workingDirectory: workingDir, homeDirectory, daemonHomeDir } = resolveDaemonCliPaths(process.env);
  // Give the shared logger a destination before anything else runs.
  //
  // `logger` buffers into a file only once `configure()` has named one; until
  // then every info/warn/error in the whole platform is dropped on the floor.
  // The TUI and agent entrypoints both do this at startup, so the standalone
  // daemon was the ONE host where a delivery failure, a rejected bot token, or
  // an unroutable reply produced no record anywhere — which is precisely how a
  // dropped surface reply looked identical to a message that never arrived.
  configureActivityLogger(join(workingDir, '.goodvibes', 'logs'));
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'goodvibes' });
  if (process.argv.includes('--install-service')) {
    installServiceAndExit(config, workingDir, homeDirectory);
  }
  new GlobalNetworkTransportInstaller().install(config);
  // Point the bus listener cap at `runtime.eventBus.maxListeners` before the
  // first bus exists, so every bus this process builds later — including ones
  // built by components that hold no ConfigManager — uses the operator's number.
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => config.get(key)));
  const runtimeBus = new RuntimeEventBus();

  ensureDaemonHome(daemonHomeDir);
  const runtimeStore = createRuntimeStore();
  const runtimeServices = createRuntimeServices({
    configManager: config,
    runtimeBus,
    runtimeStore,
    surfaceRoot: 'goodvibes',
    getConversationTitle: () => 'goodvibes daemon',
    workingDir,
    homeDirectory,
    // The real standalone daemon observes externally-launched coding-agent
    // sessions on the host read-only (fleet visibility + steer; never counted,
    // never stopped). Off in the generic factory for test determinism.
    observeExternalAgents: true,
    // The real standalone daemon owns the host sleep edge (work inhibition,
    // keep-awake, sleep-edge checkpoint/catch-up). Off in the generic factory
    // so tests never spawn systemd-inhibit / dbus-monitor host processes.
    powerSeam: createHostPowerSeam(),
  });

  const userAuth = runtimeServices.localUserAuthManager;

  const swapManager = new WorkspaceSwapManager(workingDir, {
    runtimeBus,
    daemonHomeDir,
    getBusySessionCount: () => runtimeServices.sessionBroker.countBusySessions(),
    rerootStores: (newDir: string) => runtimeServices.rerootStores(newDir),
  });

  // The daemon CLI IS the SDK-released artifact, so its update identity is
  // the SDK release version and the running executable. Embedders never get
  // this default — they pass their own artifact identity (or none).
  const daemon = new DaemonServer({ runtimeBus, userAuth, runtimeServices, swapManager, updateArtifact: { version: VERSION } });
  const listener = new HttpListener({
    hookDispatcher: runtimeServices.hookDispatcher,
    userAuth,
    configManager: config,
  });
  const { daemonToken, httpToken } = readDaemonCliTokens(process.env);

  daemon.enable({ daemon: true }, daemonToken);
  listener.enable({ httpListener: true }, httpToken);

  await Promise.all([
    daemon.start(),
    config.get('danger.httpListener') ? listener.start() : Promise.resolve(),
  ]);

  const shutdown = async (): Promise<void> => {
    logger.info('goodvibes daemon host stopping');
    await Promise.allSettled([listener.stop(), daemon.stop()]);
    // Set exitCode rather than calling process.exit(0) so that connection
    // drains can complete before the process terminates naturally. The log is
    // not left to that: it is written here, on this thread, because a shutdown
    // that then dies to a signal or a hung socket must still have said so.
    flushActivityLogSync();
    process.exitCode = 0;
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('goodvibes daemon host started', {
    daemon: resolveDaemonEnabled(config),
    httpListener: config.get('danger.httpListener'),
    workingDir,
    daemonHomeDir,
  });
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  // A daemon that dies during startup must leave the reason in BOTH places:
  // on the console for whoever ran it, and in the activity log for whoever
  // finds the host later. The log flush is synchronous and happens before the
  // exit, so process.exit() can no longer discard it.
  flushActivityLogSync();
  process.stderr.write(`goodvibes daemon host failed: ${summarizeError(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
