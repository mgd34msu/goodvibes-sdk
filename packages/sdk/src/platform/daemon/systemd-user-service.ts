/**
 * D7a Layer 1 — daemon "service install" story.
 *
 * The daemon is a SYSTEM SERVICE: many surfaces share ONE daemon, and it should
 * survive reboots. On Linux we install it as a systemd USER unit so it starts at
 * login (`WantedBy=default.target`) and is restarted on failure. On macOS/Windows
 * the install path is not implemented yet — we say so honestly and exit with a
 * clear, non-crashing code.
 *
 * The unit generation is a PURE function (see {@link renderGoodvibesDaemonUnit}):
 * input is (binary path, home, host, port); output is the exact unit file string.
 * That keeps it testable without root and without touching systemd. The actual
 * `systemctl` calls are funneled through an injectable {@link SystemctlRunner} so
 * tests never invoke the real binary.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Fixed unit file name so every surface installs/finds the same service. */
export const GOODVIBES_DAEMON_UNIT_NAME = 'goodvibes-daemon.service';

/** Default restart back-off (seconds) written into `RestartSec=`. */
export const DEFAULT_DAEMON_RESTART_SEC = 3;

const DEFAULT_UNIT_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';

/** Exit code used when the current platform has no implemented install path. */
export const SERVICE_UNSUPPORTED_EXIT_CODE = 3;

export interface DaemonUnitOptions {
  /** Absolute path to the installed daemon binary/launcher used for `ExecStart`. */
  readonly binaryPath: string;
  /** Daemon home passed through `--daemon-home` (GOODVIBES_DAEMON_HOME). */
  readonly homeDir: string;
  /** Loopback/host the daemon binds; passed through `--hostname`. */
  readonly host: string;
  /** Control-plane TCP port; passed through `--port`. */
  readonly port: number;
  /** Optional `[Unit] Description=`. */
  readonly description?: string | undefined;
  /** Optional `RestartSec=` seconds (default {@link DEFAULT_DAEMON_RESTART_SEC}). */
  readonly restartSec?: number | undefined;
}

/**
 * Build the exact ExecStart command line for the daemon: the installed binary
 * plus the resolved home/host/port flags the daemon CLI understands.
 */
export function buildDaemonExecStart(options: Pick<DaemonUnitOptions, 'binaryPath' | 'homeDir' | 'host' | 'port'>): string {
  return [
    options.binaryPath,
    '--daemon-home',
    options.homeDir,
    '--hostname',
    options.host,
    '--port',
    String(options.port),
  ].join(' ');
}

/**
 * PURE: render the systemd USER unit file contents for the GoodVibes daemon.
 * No filesystem or process access — deterministic function of its inputs.
 */
export function renderGoodvibesDaemonUnit(options: DaemonUnitOptions): string {
  const restartSec = options.restartSec ?? DEFAULT_DAEMON_RESTART_SEC;
  const description = options.description?.trim() || DEFAULT_UNIT_DESCRIPTION;
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${buildDaemonExecStart(options)}`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Absolute path of the installed systemd USER unit:
 * `<configHome>/.config/systemd/user/goodvibes-daemon.service`.
 */
export function goodvibesDaemonUnitPath(configHome: string): string {
  return join(configHome, '.config', 'systemd', 'user', GOODVIBES_DAEMON_UNIT_NAME);
}

export type SystemctlResult = {
  readonly status: number | null;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
};

/** Injectable seam for `systemctl --user <args>` — stubbed in tests. */
export type SystemctlRunner = (args: readonly string[]) => SystemctlResult;

export interface DaemonServiceEnvironment {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /** OS home where `.config/systemd/user` lives; defaults to {@link DaemonUnitOptions.homeDir}. */
  readonly configHome?: string | undefined;
  /** Runs `systemctl --user ...`; defaults to a real `spawnSync` runner. GUARDED: never called on non-Linux or in tests (tests inject a stub). */
  readonly runSystemctl?: SystemctlRunner | undefined;
  readonly writeUnitFile?: ((path: string, contents: string) => void) | undefined;
  readonly removeUnitFile?: ((path: string) => void) | undefined;
  readonly fileExists?: ((path: string) => boolean) | undefined;
}

export type DaemonServiceAction = 'install' | 'uninstall' | 'status';

export interface DaemonServiceResult {
  readonly action: DaemonServiceAction;
  readonly ok: boolean;
  readonly supported: boolean;
  readonly exitCode: number;
  readonly platform: NodeJS.Platform;
  readonly unitPath: string;
  /** Honest, human-readable stdout lines describing exactly what happened. */
  readonly lines: readonly string[];
}

function defaultSystemctlRunner(args: readonly string[]): SystemctlResult {
  const result = spawnSync('systemctl', [...args], { stdio: 'pipe', encoding: 'utf-8' });
  return {
    status: result.status,
    stdout: result.stdout ?? undefined,
    stderr: result.stderr ?? undefined,
  };
}

function resolvePlatform(env: DaemonServiceEnvironment): NodeJS.Platform {
  return env.platform ?? process.platform;
}

function unsupportedResult(
  action: DaemonServiceAction,
  platform: NodeJS.Platform,
  unitPath: string,
): DaemonServiceResult {
  const followUp = platform === 'darwin'
    ? 'track: macOS launchd follow-up'
    : platform === 'win32'
      ? 'track: Windows service follow-up'
      : 'track: macOS launchd follow-up';
  return {
    action,
    ok: false,
    supported: false,
    exitCode: SERVICE_UNSUPPORTED_EXIT_CODE,
    platform,
    unitPath,
    lines: [`service ${action} is not supported yet on ${platform} — ${followUp}`],
  };
}

function describeSystemctl(label: string, result: SystemctlResult): string {
  if (result.status === 0) return `${label}: ok`;
  const detail = (result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status ?? 'unknown'}`);
  return `${label}: FAILED (${detail})`;
}

/**
 * Install the daemon as a systemd USER service (Linux) and enable it now so it
 * starts at login and survives reboots. On non-Linux, returns an honest
 * unsupported result with {@link SERVICE_UNSUPPORTED_EXIT_CODE}.
 */
export function installGoodvibesDaemonUserService(
  options: DaemonUnitOptions,
  env: DaemonServiceEnvironment = {},
): DaemonServiceResult {
  const platform = resolvePlatform(env);
  const configHome = env.configHome ?? options.homeDir;
  const unitPath = goodvibesDaemonUnitPath(configHome);
  if (platform !== 'linux') {
    return unsupportedResult('install', platform, unitPath);
  }

  const runSystemctl = env.runSystemctl ?? defaultSystemctlRunner;
  const write = env.writeUnitFile ?? ((path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf-8');
  });

  const contents = renderGoodvibesDaemonUnit(options);
  write(unitPath, contents);

  const reload = runSystemctl(['--user', 'daemon-reload']);
  const enable = runSystemctl(['--user', 'enable', '--now', GOODVIBES_DAEMON_UNIT_NAME]);
  const ok = (reload.status === 0) && (enable.status === 0);

  return {
    action: 'install',
    ok,
    supported: true,
    exitCode: ok ? 0 : 1,
    platform,
    unitPath,
    lines: [
      `wrote systemd user unit: ${unitPath}`,
      `ExecStart=${buildDaemonExecStart(options)}`,
      describeSystemctl('systemctl --user daemon-reload', reload),
      describeSystemctl(`systemctl --user enable --now ${GOODVIBES_DAEMON_UNIT_NAME}`, enable),
      ok
        ? `daemon service enabled and started; it will start at login and restart on failure.`
        : `daemon service install did not fully succeed — see the FAILED line(s) above.`,
      `to disable: systemctl --user disable --now ${GOODVIBES_DAEMON_UNIT_NAME}`,
    ],
  };
}

/**
 * Uninstall the daemon service: disable-and-stop it, then remove the unit file.
 * Non-Linux returns the honest unsupported result.
 */
export function uninstallGoodvibesDaemonUserService(
  options: Pick<DaemonUnitOptions, 'homeDir'>,
  env: DaemonServiceEnvironment = {},
): DaemonServiceResult {
  const platform = resolvePlatform(env);
  const configHome = env.configHome ?? options.homeDir;
  const unitPath = goodvibesDaemonUnitPath(configHome);
  if (platform !== 'linux') {
    return unsupportedResult('uninstall', platform, unitPath);
  }

  const runSystemctl = env.runSystemctl ?? defaultSystemctlRunner;
  const remove = env.removeUnitFile ?? ((path: string) => rmSync(path, { force: true }));
  const fileExists = env.fileExists ?? ((path: string) => existsSync(path));

  const disable = runSystemctl(['--user', 'disable', '--now', GOODVIBES_DAEMON_UNIT_NAME]);
  const existed = fileExists(unitPath);
  remove(unitPath);
  const reload = runSystemctl(['--user', 'daemon-reload']);
  const ok = disable.status === 0 && reload.status === 0;

  return {
    action: 'uninstall',
    ok,
    supported: true,
    exitCode: ok ? 0 : 1,
    platform,
    unitPath,
    lines: [
      describeSystemctl(`systemctl --user disable --now ${GOODVIBES_DAEMON_UNIT_NAME}`, disable),
      existed ? `removed systemd user unit: ${unitPath}` : `no systemd user unit found at: ${unitPath}`,
      describeSystemctl('systemctl --user daemon-reload', reload),
    ],
  };
}

/**
 * Report whether the daemon service unit is installed / enabled / active.
 * Non-Linux returns the honest unsupported result.
 */
export function goodvibesDaemonUserServiceStatus(
  options: Pick<DaemonUnitOptions, 'homeDir'>,
  env: DaemonServiceEnvironment = {},
): DaemonServiceResult {
  const platform = resolvePlatform(env);
  const configHome = env.configHome ?? options.homeDir;
  const unitPath = goodvibesDaemonUnitPath(configHome);
  if (platform !== 'linux') {
    return unsupportedResult('status', platform, unitPath);
  }

  const runSystemctl = env.runSystemctl ?? defaultSystemctlRunner;
  const fileExists = env.fileExists ?? ((path: string) => existsSync(path));

  const installed = fileExists(unitPath);
  const isEnabled = runSystemctl(['--user', 'is-enabled', GOODVIBES_DAEMON_UNIT_NAME]);
  const isActive = runSystemctl(['--user', 'is-active', GOODVIBES_DAEMON_UNIT_NAME]);
  const enabled = (isEnabled.stdout ?? '').trim();
  const active = (isActive.stdout ?? '').trim();

  return {
    action: 'status',
    ok: true,
    supported: true,
    exitCode: 0,
    platform,
    unitPath,
    lines: [
      `unit: ${unitPath}`,
      `installed: ${installed ? 'yes' : 'no'}`,
      `enabled: ${enabled || 'unknown'}`,
      `active: ${active || 'unknown'}`,
      installed
        ? `to disable: systemctl --user disable --now ${GOODVIBES_DAEMON_UNIT_NAME}`
        : `to install: goodvibes-daemon install-service`,
    ],
  };
}
