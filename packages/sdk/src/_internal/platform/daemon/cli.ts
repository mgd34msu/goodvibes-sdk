import { homedir } from 'node:os';
import { ConfigManager } from '../config/manager.js';
import { RuntimeEventBus } from '../runtime/events/index.js';
import { createRuntimeStore } from '../runtime/store/index.js';
import { createRuntimeServices } from '../runtime/services.js';
import { DaemonServer } from './server.js';
import { HttpListener } from './http-listener.js';
import { logger } from '../utils/logger.js';
import { GlobalNetworkTransportInstaller } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveDaemonHomeDir, runDaemonHomeMigration, readDaemonSetting } from '../workspace/daemon-home.js';

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

function resolveDaemonCliOwnership(env: NodeJS.ProcessEnv = process.env): DaemonCliOwnership {
  const daemonHomeArg = parseCliFlag(process.argv, '--daemon-home');
  const workingDirArg = parseCliFlag(process.argv, '--working-dir');

  const daemonHomeDir = resolveDaemonHomeDir({ daemonHomeArg, env });
  const { daemonHomeDir: resolvedDaemonHomeDir } = runDaemonHomeMigration(daemonHomeDir, { cwd: process.cwd(), env });

  // Working dir resolution: flag > env > daemon-settings.json persisted > cwd
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

async function main(): Promise<void> {
  const { workingDirectory: workingDir, homeDirectory, daemonHomeDir } = resolveDaemonCliOwnership(process.env);
  const config = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'goodvibes' });
  new GlobalNetworkTransportInstaller().install(config);
  const runtimeBus = new RuntimeEventBus();
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
  const daemon = new DaemonServer({ runtimeBus, userAuth, runtimeServices });
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
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('goodvibes daemon host started', {
    daemon: config.get('danger.daemon'),
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
