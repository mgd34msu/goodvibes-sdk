import { homedir } from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { resolveDaemonEnabled } from '../config/index.js';
import { RuntimeEventBus } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { createRuntimeServices } from '../runtime/services.js';
import { DaemonServer } from './server.js';
import { HttpListener } from './http-listener.js';
import { PlatformServiceManager } from './service-manager.js';
import { VERSION } from '../version.js';
import { logger } from '../utils/logger.js';
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
    console.log(`service unit installed: ${result.path} (${result.serviceName}, ${result.platform})`);
    for (const command of result.suggestedCommands) console.log(`  next: ${command}`);
    if (result.lingerNote) console.log(result.lingerNote);
    process.exit(0);
  } catch (error) {
    console.error(`service install failed: ${summarizeError(error)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { workingDirectory: workingDir, homeDirectory, daemonHomeDir } = resolveDaemonCliPaths(process.env);
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'goodvibes' });
  if (process.argv.includes('--install-service')) {
    installServiceAndExit(config, workingDir, homeDirectory);
  }
  new GlobalNetworkTransportInstaller().install(config);
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
    await Promise.allSettled([listener.stop(), daemon.stop()]);
    // Set exitCode rather than calling process.exit(0) so that any
    // already-queued I/O (log flushes, connection drains) can complete
    // before the process terminates naturally.
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
  process.exit(1);
});
