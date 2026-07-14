import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn, type SpawnOptions } from 'node:child_process';
import { ConfigManager } from '../config/manager.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import { currentProcessSignals, resolveDaemonExecInvocation } from './daemon-exec-invocation.js';

export type ManagedServicePlatform = 'systemd' | 'launchd' | 'windows' | 'manual';

export interface ManagedServiceDefinition {
  readonly name: string;
  readonly description: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly restartOnFailure: boolean;
}

export interface ManagedServiceStatus {
  readonly platform: ManagedServicePlatform;
  /** The resolved service name (`service.serviceName` config, else the built-in default) — so a CLI/consumer never has to hardcode it. */
  readonly serviceName: string;
  readonly path: string;
  readonly installed: boolean;
  readonly autostart: boolean;
  readonly running: boolean;
  readonly pid?: number | undefined;
  readonly logPath?: string | undefined;
  readonly commandPreview: string;
  readonly contents?: string | undefined;
  readonly suggestedCommands: readonly string[];
  readonly lastAction?: 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status' | undefined;
  readonly actionError?: string | undefined;
  /**
   * One honest line about login lingering after an install on systemd:
   * verified-on means the daemon starts at boot; anything else names the
   * exact command the user can run once themselves.
   */
  readonly lingerNote?: string | undefined;
}

export interface ManagedServiceActionResult {
  readonly status: number | null;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

interface ManagedServicePaths {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface ManagedServiceManagerOptions extends ManagedServicePaths {
  readonly definitionOverride?: ManagedServiceDefinition | undefined;
  readonly actionRunner?: ((command: string, args: readonly string[]) => ManagedServiceActionResult) | undefined;
  readonly surfaceRoot?: string | undefined;
  readonly binaryBaseName?: string | undefined;
  readonly defaultServiceName?: string | undefined;
  readonly defaultServiceDescription?: string | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
}

function detectPlatform(platform: string): ManagedServicePlatform {
  switch (platform) {
    case 'systemd':
    case 'launchd':
    case 'windows':
    case 'manual':
      return platform;
    case 'auto':
    default:
      if (process.platform === 'darwin') return 'launchd';
      if (process.platform === 'win32') return 'windows';
      if (process.platform === 'linux') return 'systemd';
      return 'manual';
  }
}

function buildDefaultDefinition(
  configManager: ConfigManager,
  workingDirectory: string,
  options: Pick<ManagedServiceManagerOptions, 'binaryBaseName' | 'defaultServiceName' | 'defaultServiceDescription'>,
): ManagedServiceDefinition {
  const serviceName = resolveServiceName(configManager, options.defaultServiceName);
  // ExecStart is derived from how THIS process was actually started — a compiled
  // binary launches itself with its real argv; only a source/dev run yields the
  // `run <cli.ts>` shape (and that path is never self-promoted, see
  // facade-lifecycle.promoteToServiceAtBoot). This replaces a dist/-existence
  // heuristic that wrote a dev command line for a compiled binary running
  // elsewhere.
  const invocation = resolveDaemonExecInvocation(currentProcessSignals(), workingDirectory);
  return {
    name: serviceName,
    description: options.defaultServiceDescription?.trim() || `${serviceName} daemon host`,
    workingDirectory,
    command: invocation.command,
    args: invocation.args,
    env: {
      GOODVIBES_DAEMON_TOKEN: process.env.GOODVIBES_DAEMON_TOKEN ?? '',
      GOODVIBES_HTTP_TOKEN: process.env.GOODVIBES_HTTP_TOKEN ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
    restartOnFailure: Boolean(configManager.get('service.restartOnFailure')),
  };
}

function resolveServiceName(configManager: ConfigManager, defaultServiceName = 'daemon'): string {
  return String(configManager.get('service.serviceName') ?? defaultServiceName).trim() || defaultServiceName;
}

function resolveLogPath(
  configManager: ConfigManager,
  platform: ManagedServicePlatform,
  workingDirectory: string,
  surfaceRoot?: string,
): string {
  const configured = String(configManager.get('service.logPath') ?? '').trim();
  if (configured) return resolve(workingDirectory, configured);
  return resolveScopedDirectory(workingDirectory, surfaceRoot, 'service', `${platform}.log`);
}

/**
 * Escalating restart delays (RestartSteps=/RestartMaxDelaySec=) landed in
 * systemd 254. On older systemd — or when the version cannot be read — the
 * unit degrades to the flat RestartSec retry, which StartLimitIntervalSec=0
 * already keeps retrying forever instead of tombstoning.
 */
export function systemdSupportsRestartSteps(majorVersion: number | null): boolean {
  return majorVersion !== null && majorVersion >= 254;
}

/** First line of `systemctl --version` is "systemd NNN (...)"; returns NNN or null. */
export function parseSystemdMajorVersion(versionOutput: string | undefined): number | null {
  const firstLine = (versionOutput ?? '').split('\n')[0] ?? '';
  const match = firstLine.match(/^systemd (\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Survival contract for a restartOnFailure unit: StartLimitIntervalSec=0
 * disables the start-rate limiter, so a crashing daemon keeps retrying
 * (spaced by the delays below) instead of landing in the permanent
 * "start-limit-hit" failed state that only a manual reset-failed clears. On
 * systemd 254+ the retry delay escalates from RestartSec up to
 * RestartMaxDelaySec across RestartSteps attempts; on older systemd those
 * two directives are omitted (they would be ignored with a warning) and the
 * flat RestartSec applies to every retry.
 */
export function renderSystemdUnit(
  definition: ManagedServiceDefinition,
  systemdMajorVersion: number | null = null,
): string {
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `Environment=${key}=${value.replace(/"/g, '\\"')}`);
  const restartLines = definition.restartOnFailure
    ? [
        'Restart=on-failure',
        'RestartSec=2',
        ...(systemdSupportsRestartSteps(systemdMajorVersion)
          ? ['RestartSteps=8', 'RestartMaxDelaySec=300']
          : []),
      ]
    : ['Restart=no'];
  return [
    '[Unit]',
    `Description=${definition.description}`,
    'After=network-online.target',
    ...(definition.restartOnFailure ? ['StartLimitIntervalSec=0'] : []),
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${definition.workingDirectory}`,
    `ExecStart=${[definition.command, ...definition.args].join(' ')}`,
    ...envLines,
    ...restartLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function renderLaunchdPlist(definition: ManagedServiceDefinition): string {
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join('\n');
  const args = [definition.command, ...definition.args]
    .map((value) => `    <string>${value}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${definition.name}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${definition.workingDirectory}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    definition.restartOnFailure ? '  <true/>' : '  <false/>',
    ...(envLines ? ['  <key>EnvironmentVariables</key>', '  <dict>', envLines, '  </dict>'] : []),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function renderWindowsCommand(definition: ManagedServiceDefinition): string {
  const taskName = definition.name;
  const commandLine = [definition.command, ...definition.args].join(' ');
  return `schtasks /Create /SC ONLOGON /TN "${taskName}" /TR "${commandLine}" /F`;
}

function definitionPath(
  platform: ManagedServicePlatform,
  serviceName: string,
  paths: ManagedServicePaths,
  surfaceRoot?: string,
): string {
  switch (platform) {
    case 'systemd':
      return join(paths.homeDirectory, '.config', 'systemd', 'user', `${serviceName}.service`);
    case 'launchd':
      return join(paths.homeDirectory, 'Library', 'LaunchAgents', `${serviceName}.plist`);
    case 'windows':
      return resolveScopedDirectory(paths.workingDirectory, surfaceRoot, 'service', 'windows-task.txt');
    case 'manual':
    default:
      return resolveScopedDirectory(paths.workingDirectory, surfaceRoot, 'service', 'manual-service.txt');
  }
}

function pidFilePath(platform: ManagedServicePlatform, workingDirectory: string, surfaceRoot?: string): string {
  switch (platform) {
    case 'systemd':
    case 'launchd':
    case 'windows':
    case 'manual':
    default:
      return resolveScopedDirectory(workingDirectory, surfaceRoot, 'service', `${platform}.pid`);
  }
}

function suggestedCommands(platform: ManagedServicePlatform, path: string, serviceName: string): string[] {
  switch (platform) {
    case 'systemd':
      return [
        `systemctl --user daemon-reload`,
        `systemctl --user enable --now ${serviceName}.service`,
        `systemctl --user status ${serviceName}.service`,
      ];
    case 'launchd':
      return [
        `launchctl unload ${path} || true`,
        `launchctl load ${path}`,
        `launchctl list | grep ${serviceName}`,
      ];
    case 'windows':
      return [
        `schtasks /Run /TN "${serviceName}"`,
        `schtasks /Query /TN "${serviceName}"`,
        `schtasks /Delete /TN "${serviceName}" /F`,
      ];
    case 'manual':
    default:
      return [
        `bun run src/daemon/cli.ts`,
      ];
  }
}

export class PlatformServiceManager {
  private readonly configManager: ConfigManager;
  private readonly workingDirectory: string;
  private readonly homeDirectory: string;
  private readonly definitionOverride?: ManagedServiceDefinition | undefined;
  private readonly actionRunner?: ((command: string, args: readonly string[]) => ManagedServiceActionResult) | undefined;
  private readonly surfaceRoot?: string | undefined;
  private readonly binaryBaseName?: string | undefined;
  private readonly defaultServiceName?: string | undefined;
  private readonly defaultServiceDescription?: string | undefined;
  private readonly featureFlags: FeatureFlagReader;

  constructor(configManager: ConfigManager, options: ManagedServiceManagerOptions) {
    this.configManager = configManager;
    this.workingDirectory = resolve(options.workingDirectory);
    this.homeDirectory = resolve(options.homeDirectory);
    this.definitionOverride = options.definitionOverride;
    this.actionRunner = options.actionRunner;
    this.surfaceRoot = options.surfaceRoot;
    this.binaryBaseName = options.binaryBaseName;
    this.defaultServiceName = options.defaultServiceName;
    this.defaultServiceDescription = options.defaultServiceDescription;
    this.featureFlags = options.featureFlags ?? null;
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'service-management');
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'service-management', operation);
  }

  private getPaths(): ManagedServicePaths {
    return {
      workingDirectory: this.workingDirectory,
      homeDirectory: this.homeDirectory,
    };
  }

  status(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.getPaths(), this.surfaceRoot);
    if (!this.isEnabled()) {
      const definition = this.resolveDefinition();
      return {
        platform,
        serviceName,
        path,
        installed: false,
        autostart: false,
        running: false,
        logPath: resolveLogPath(this.configManager, platform, this.workingDirectory, this.surfaceRoot),
        commandPreview: [definition.command, ...definition.args].join(' '),
        suggestedCommands: [],
        lastAction: 'status',
        actionError: 'service management is turned off (see the service.enabled setting)',
      };
    }
    const installed = existsSync(path);
    const { running, pid } = this.queryRunning(platform, serviceName);
    const definition = this.resolveDefinition();
    return {
      platform,
      serviceName,
      path,
      installed,
      autostart: Boolean(this.configManager.get('service.autostart')),
      running,
      ...(pid !== undefined && running ? { pid } : {}),
      logPath: resolveLogPath(this.configManager, platform, this.workingDirectory, this.surfaceRoot),
      commandPreview: installed ? path : [definition.command, ...definition.args].join(' '),
      contents: installed ? readFileSync(path, 'utf-8') : undefined,
      suggestedCommands: suggestedCommands(platform, path, serviceName),
      lastAction: 'status',
    };
  }

  install(): ManagedServiceStatus {
    this.requireEnabled('install service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const definition = this.resolveDefinition();
    const path = definitionPath(platform, serviceName, this.getPaths(), this.surfaceRoot);
    const contents = platform === 'systemd'
      ? renderSystemdUnit(definition, this.detectSystemdMajorVersion())
      : platform === 'launchd'
        ? renderLaunchdPlist(definition)
        : platform === 'windows'
          ? renderWindowsCommand(definition)
          : [definition.command, ...definition.args].join(' ');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${contents}\n`, 'utf-8');
    const lingerNote = platform === 'systemd' ? this.ensureLinger() : undefined;
    return {
      ...this.status(),
      lastAction: 'install',
      ...(lingerNote ? { lingerNote } : {}),
    };
  }

  /** systemd major version via the injected runner, or null when unreadable. */
  private detectSystemdMajorVersion(): number | null {
    const result = this.runQuery('systemctl', ['--version']);
    if (result.status !== 0) return null;
    return parseSystemdMajorVersion(result.stdout);
  }

  /**
   * A user unit with WantedBy=default.target only starts when its user logs
   * in. Lingering starts the user's systemd instance at boot, so the daemon
   * comes up on a machine nobody has logged into. `loginctl enable-linger`
   * can exit 0 without taking effect in some polkit setups, so the
   * show-user property readback is the source of truth, checked before and
   * after enabling. Returns exactly one honest line either way.
   */
  private ensureLinger(): string {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    if (!user) {
      return 'lingering: could not determine the current user — the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger <user>';
    }
    const lingerEnabled = (): boolean => {
      const readback = this.runQuery('loginctl', ['show-user', user, '--property=Linger']);
      return readback.status === 0 && (readback.stdout ?? '').trim() === 'Linger=yes';
    };
    if (lingerEnabled()) {
      return `lingering: already enabled for ${user} — the daemon starts at boot.`;
    }
    this.runQuery('loginctl', ['enable-linger', user]);
    if (lingerEnabled()) {
      return `lingering: enabled for ${user} — the daemon starts at boot.`;
    }
    return `lingering: could not be enabled (polkit may require an interactive session) — the daemon starts at login rather than at boot. Enable it once yourself with: loginctl enable-linger ${user}`;
  }

  uninstall(): ManagedServiceStatus {
    this.requireEnabled('uninstall service');
    const status = this.status();
    if (existsSync(status.path)) {
      rmSync(status.path, { force: true });
    }
    const pidPath = pidFilePath(status.platform, this.workingDirectory, this.surfaceRoot);
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    return {
      ...this.status(),
      lastAction: 'uninstall',
    };
  }

  start(): ManagedServiceStatus {
    this.requireEnabled('start service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      return this.startManual(platform);
    }
    return this.runPlatformAction(platform, 'start');
  }

  stop(): ManagedServiceStatus {
    this.requireEnabled('stop service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      return this.stopManual(platform);
    }
    return this.runPlatformAction(platform, 'stop');
  }

  restart(): ManagedServiceStatus {
    this.requireEnabled('restart service');
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      this.stopManual(platform);
      return this.startManual(platform, 'restart');
    }
    return this.runPlatformAction(platform, 'restart');
  }

  private resolveDefinition(): ManagedServiceDefinition {
    return this.definitionOverride ?? buildDefaultDefinition(this.configManager, this.workingDirectory, {
      binaryBaseName: this.binaryBaseName,
      defaultServiceName: this.defaultServiceName,
      defaultServiceDescription: this.defaultServiceDescription,
    });
  }

  private startManual(platform: ManagedServicePlatform, action: ManagedServiceStatus['lastAction'] = 'start'): ManagedServiceStatus {
    const current = this.status();
    if (current.running) {
      return {
        ...current,
        lastAction: action,
      };
    }
    const definition = this.resolveDefinition();
    const logPath = resolveLogPath(this.configManager, platform, this.workingDirectory, this.surfaceRoot);
    const pidPath = pidFilePath(platform, this.workingDirectory, this.surfaceRoot);
    mkdirSync(dirname(pidPath), { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true });
    const stdoutFd = openSync(logPath, 'a');
    const stderrFd = openSync(logPath, 'a');
    let child: ReturnType<typeof spawn>;
    try {
      const spawnOptions: SpawnOptions = {
        cwd: definition.workingDirectory,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
          ...process.env,
          ...definition.env,
        },
      };
      child = spawn(definition.command, [...definition.args], spawnOptions);
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');
    return {
      ...this.status(),
      lastAction: action,
    };
  }

  private stopManual(platform: ManagedServicePlatform): ManagedServiceStatus {
    const pidPath = pidFilePath(platform, this.workingDirectory, this.surfaceRoot);
    const pid = existsSync(pidPath) ? this.readPid(pidPath) : undefined;
    if (pid !== undefined && this.isPidRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore stale processes
      }
    }
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    return {
      ...this.status(),
      lastAction: 'stop',
    };
  }

  private runPlatformAction(platform: ManagedServicePlatform, action: 'start' | 'stop' | 'restart'): ManagedServiceStatus {
    const serviceName = resolveServiceName(this.configManager, this.defaultServiceName);
    const path = definitionPath(platform, serviceName, this.getPaths(), this.surfaceRoot);
    // Each step is an argv plus a bestEffort flag. launchd has no native restart
    // verb, so restart is an honest unload-then-load; the unload is best-effort
    // (the agent may simply not be loaded yet), mirroring suggestedCommands()'
    // human-facing `launchctl unload <path> || true`.
    const steps: ReadonlyArray<{ readonly argv: readonly string[]; readonly bestEffort?: boolean }> = platform === 'systemd'
      ? [{ argv: ['systemctl', '--user', action === 'start' ? 'enable' : action, ...(action === 'start' ? ['--now'] : []), `${serviceName}.service`] }]
      : platform === 'launchd'
        ? action === 'restart'
          ? [
              { argv: ['launchctl', 'unload', path], bestEffort: true },
              { argv: ['launchctl', 'load', path] },
            ]
          : [{ argv: ['launchctl', action === 'stop' ? 'unload' : 'load', path] }]
        : platform === 'windows'
          ? [{ argv: ['schtasks', action === 'start' ? '/Run' : action === 'stop' ? '/End' : '/Run', '/TN', serviceName] }]
          : [];
    if (steps.length === 0) {
      return {
        ...this.status(),
        lastAction: action,
        actionError: `Unsupported platform action: ${platform}`,
      };
    }
    let actionError: string | undefined;
    for (const step of steps) {
      const argv = step.argv;
      const result = this.runQuery(argv[0]!, argv.slice(1));
      if ((result.status ?? 1) !== 0 && !step.bestEffort) {
        actionError = ((result.stderr ?? '') || (result.stdout ?? '') || `command exited with ${result.status}`).trim();
        break;
      }
    }
    return {
      ...this.status(),
      lastAction: action,
      ...(actionError === undefined ? {} : { actionError }),
    };
  }

  /**
   * Resolves `running` (+ `pid` when known) for `status()`. Only the manual
   * platform's `startManual` ever writes the pid file (`start()` branches on
   * `platform === 'manual'` before ever calling `runPlatformAction`), so for
   * systemd/launchd the pid file is permanently absent and a pid-file-only
   * check would report `running: false` for a genuinely active unit. systemd
   * and launchd are queried live instead, through the same injected
   * `actionRunner` used by start/stop/restart (never a raw exec bypassing it,
   * so tests can fake the query deterministically).
   */
  private queryRunning(platform: ManagedServicePlatform, serviceName: string): { running: boolean; pid?: number | undefined } {
    if (platform === 'systemd' || platform === 'launchd') {
      return this.queryPlatformRunning(platform, serviceName);
    }
    const pidPath = pidFilePath(platform, this.workingDirectory, this.surfaceRoot);
    const pid = existsSync(pidPath) ? this.readPid(pidPath) : undefined;
    const running = pid !== undefined ? this.isPidRunning(pid) : false;
    if (!running && existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    return running ? { running, pid } : { running };
  }

  private queryPlatformRunning(
    platform: 'systemd' | 'launchd',
    serviceName: string,
  ): { running: boolean; pid?: number | undefined } {
    if (platform === 'systemd') {
      const result = this.runQuery('systemctl', ['--user', 'is-active', `${serviceName}.service`]);
      const state = (result.stdout ?? '').trim();
      return { running: (result.status ?? 1) === 0 && state === 'active' };
    }
    // launchd: no single-job query is used here — `launchctl list <label>` prints
    // a plist dump on modern macOS, not a stable parseable field. Instead run the
    // plain `launchctl list` (same command this module's suggestedCommands()
    // already tells operators to run: `launchctl list | grep <name>`) and find the
    // job's own tabular line: `<pid-or-dash>\t<last-exit-status>\t<label>`. No
    // matching line = not loaded = not running; a `-` PID column = loaded but
    // stopped; a numeric PID = running.
    const result = this.runQuery('launchctl', ['list']);
    const match = (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => fields[fields.length - 1] === serviceName);
    if (!match) return { running: false };
    const pidToken = match[0];
    const pid = pidToken && /^\d+$/.test(pidToken) ? Number(pidToken) : undefined;
    return pid !== undefined ? { running: true, pid } : { running: false };
  }

  /** Runs a service-management query/action through the injected actionRunner when present, else a real spawnSync — the single choke point start/stop/restart/status share. */
  private runQuery(command: string, args: readonly string[]): ManagedServiceActionResult {
    return this.actionRunner
      ? this.actionRunner(command, args)
      : spawnSync(command, args, { stdio: 'pipe', encoding: 'utf-8' });
  }

  private readPid(path: string): number | undefined {
    const raw = readFileSync(path, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
