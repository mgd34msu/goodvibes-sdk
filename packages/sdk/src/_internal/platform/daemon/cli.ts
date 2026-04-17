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

type DaemonCliOwnership = {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

type DaemonCliTokens = {
  readonly daemonToken: string | undefined;
  readonly httpToken: string | undefined;
};

function resolveDaemonCliOwnership(): DaemonCliOwnership {
  return {
    workingDirectory: process.cwd(),
    homeDirectory: homedir(),
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
  const { workingDirectory: workingDir, homeDirectory } = resolveDaemonCliOwnership();
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
  });
}

void main().catch(async (error) => {
  logger.error('goodvibes daemon host failed', {
    error: summarizeError(error),
  });
  process.exit(1);
});
