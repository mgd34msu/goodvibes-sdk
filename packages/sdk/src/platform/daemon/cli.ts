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
import { ensureDaemonHome } from '../workspace/daemon-home.js';
import { resolveDaemonCliPaths } from './cli-paths.js';
import { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from './fatal-boot-report.js';
import { WorkspaceSwapManager } from '../workspace/workspace-swap-manager.js';

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

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
 * follow-up commands, no raw HTTP call, no admin-token juggling. This is
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
    // Written synchronously: every line here is immediately followed by a
    // process exit, and a stream write can still be in flight when it lands.
    writeExitingStdoutLine(`service unit installed: ${result.path} (${result.serviceName}, ${result.platform})`);
    for (const command of result.suggestedCommands) writeExitingStdoutLine(`  next: ${command}`);
    if (result.lingerNote) writeExitingStdoutLine(result.lingerNote);
    process.exit(0);
  } catch (error) {
    writeFatalLine(`service install failed: ${summarizeError(error)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { workingDirectory: workingDir, homeDirectory, daemonHomeDir, daemonTierPath } = resolveDaemonCliPaths();
  // Give the shared logger a destination before anything else runs.
  //
  // `logger` buffers into a file only once `configure()` has named one; until
  // then every info/warn/error in the whole platform is dropped on the floor.
  // The TUI and agent entrypoints both do this at startup, so the standalone
  // daemon was the ONE host where a delivery failure, a rejected bot token, or
  // an unroutable reply produced no record anywhere, which is precisely how a
  // dropped surface reply looked identical to a message that never arrived.
  configureActivityLogger(join(workingDir, '.goodvibes', 'logs'));
  // `--daemon-home` / `GOODVIBES_DAEMON_HOME` names the daemon's own state
  // directory (`~/.goodvibes/daemon` by default). It was parsed here and then
  // threaded only into the identity files, `ensureDaemonHome`, the operator
  // token path, while the ConfigManager derived its daemon tier from
  // `homedir()` regardless. So a daemon told to keep its state somewhere else
  // read its settings from the real home anyway, and the flag silently governed
  // half of what it names. daemon-config-tier.ts has always said a caller
  // honouring the flag should resolve the home first and use
  // `daemonConfigPathForHome`; this is that caller finally doing it.
  const config = new ConfigManager({
    workingDir,
    homeDir: homeDirectory,
    surfaceRoot: 'goodvibes',
    daemonTierPath,
    // The standalone daemon owns its settings store, so it is the process that
    // migrates that file on disk. Every client reads the same file and applies
    // migrations only to its own in-memory view.
    ownsDaemonTier: true,
  });
  if (process.argv.includes('--install-service')) {
    installServiceAndExit(config, workingDir, homeDirectory);
  }
  new GlobalNetworkTransportInstaller().install(config);
  // Point the bus listener cap at `runtime.eventBus.maxListeners` before the
  // first bus exists, so every bus this process builds later, including ones
  // built by components that hold no ConfigManager, uses the operator's number.
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
    // The same override, threaded into the credential store so it MOVES the
    // daemon-scoped secret tier too. runtime/secrets-composition.ts records
    // what happened while no composition root passed it: a throwaway daemon
    // given `--daemon-home /tmp/...` kept reading the owner's real secret
    // store, long-polled their real bot token, and stopped their inbound messages.
    daemonHome: daemonHomeDir,
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
  // this default, they pass their own artifact identity (or none).
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
  // A daemon that dies during startup must leave the reason where an operator
  // will actually find it: on the file descriptor the service journal is
  // attached to, written synchronously, BEFORE the activity log is attempted.
  // Doing it the other way round is what shipped mute, see fatal-boot-report.ts.
  reportFatalBootFailure(error);
  process.exit(1);
});
