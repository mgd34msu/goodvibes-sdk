/**
 * daemon-autostart.ts — starting a daemon that is installed but not running,
 * once, at boot.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A surface product used to solve "no daemon on the port" by BEING one: it
 * embedded a daemon server in its own process. That is gone — the daemon is its
 * own product and a surface adopts one or does without.
 *
 * Which leaves a case that must not become the user's problem: the daemon is
 * installed on this machine, the service is simply stopped, and the surface
 * boots to "no daemon" with a suggestion to go type something. So boot
 * discovery gets exactly one recovery step — ask the platform service manager
 * whether the daemon's service entry exists, start it if it does, wait a bounded
 * time, and re-probe.
 *
 * Both surface products grew this independently and arrived at the same policy,
 * with each carrying one thing the other lacked. This is the union of the two:
 * the terminal app's outcome renderer and its prefer-an-already-running-unit
 * choice, and the chat host's attempt-counted wait (which terminates even with
 * an injected no-op sleep), its `platform`/`unitPath` reporting, its
 * duplicate-name de-duplication, and its explicit refusal when the only
 * installed entry is one no service manager here can start.
 *
 * ── The boundaries, which stay strict ──────────────────────────────────────
 *
 * - A REACHABLE daemon is never restarted. Adopting is the whole point.
 * - A HELD port — `blocked` (an unverified process) or `incompatible` (a
 *   GoodVibes daemon on a wire version this build refuses) — is left alone.
 *   Those are the closest states a probe has to "another owner is mid-update",
 *   and stepping on either turns a transient state into an outage.
 * - A service the manager already reports ACTIVE gets a bounded wait, never a
 *   second start underneath it.
 * - A daemon that is genuinely NOT installed gets honest guidance and nothing
 *   else. A surface never spawns one.
 * - Every failure is reported and none of them break boot. Discovery failing is
 *   a reason to say so, not a reason to refuse to start.
 */
import { PlatformServiceManager, type ManagedServiceActionResult, type ManagedServiceStatus } from '../../daemon/index.js';
import { logger, summarizeError } from '../../utils/index.js';
import type { ConfigManager } from '../../config/manager.js';

/** The daemon's managed service name (what the installer registers). */
export const MANAGED_DAEMON_SERVICE_NAME = 'goodvibes';
/** The unit name older installs registered. */
export const LEGACY_DAEMON_SERVICE_NAME = 'goodvibes-daemon';

/** The service manager's action-runner result, under this module's name. */
export type DaemonServiceActionResult = ManagedServiceActionResult;

/** One candidate service entry, as the platform service manager sees it. */
export interface DaemonServiceSnapshot {
  readonly serviceName: string;
  readonly platform: ManagedServiceStatus['platform'] | 'unknown';
  readonly unitPath: string;
  readonly installed: boolean;
  readonly running: boolean;
  /**
   * False on the 'manual' platform: there the service manager would spawn its
   * own locally-resolved command, which a surface cannot honestly resolve for a
   * daemon it does not own — those stay on the guidance path.
   */
  readonly startSupported: boolean;
}

export interface DaemonServiceStartResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/** The narrow detector/starter seam, so tests never touch the host's services. */
export interface DaemonServiceControl {
  snapshot(): readonly DaemonServiceSnapshot[];
  start(serviceName: string): DaemonServiceStartResult;
}

export interface DaemonServiceControlOptions {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** Injectable systemctl/launchctl/schtasks runner. */
  readonly actionRunner?: ((command: string, args: readonly string[]) => DaemonServiceActionResult) | undefined;
}

/**
 * Build the detector/starter over `PlatformServiceManager`.
 *
 * When `service.serviceName` is configured to something other than the managed
 * default, that is an explicit operator choice and is trusted exclusively;
 * otherwise the managed name AND the older unit name are both checked, so an
 * install that predates the rename is still found.
 */
export function createDaemonServiceControl(options: DaemonServiceControlOptions): DaemonServiceControl {
  const primaryName = String(options.configManager.get('service.serviceName') ?? '').trim() || MANAGED_DAEMON_SERVICE_NAME;
  const candidateNames = primaryName === MANAGED_DAEMON_SERVICE_NAME
    ? [MANAGED_DAEMON_SERVICE_NAME, LEGACY_DAEMON_SERVICE_NAME]
    : [primaryName];
  // Pin each manager's view of `service.serviceName` to its candidate so the
  // manager's own resolution yields exactly that unit; the schema default would
  // otherwise shadow every `defaultServiceName`. Only `get` is consulted by the
  // manager, so the narrow delegate below is honest.
  const pinnedConfigView = (serviceName: string): ConfigManager => ({
    get: (key: string) => key === 'service.serviceName' ? serviceName : options.configManager.get(key as Parameters<ConfigManager['get']>[0]),
  }) as unknown as ConfigManager;
  const managers = candidateNames.map((resolvedName) => ({
    resolvedName,
    manager: new PlatformServiceManager(pinnedConfigView(resolvedName), {
      workingDirectory: options.workingDirectory,
      homeDirectory: options.homeDirectory,
      // Match the daemon's own service scope (log/pid layout on the manual
      // platform); systemd/launchd/windows entries are home-scoped anyway.
      surfaceRoot: 'daemon',
      defaultServiceName: resolvedName,
      ...(options.actionRunner ? { actionRunner: options.actionRunner } : {}),
    }),
  }));

  return {
    snapshot: () => {
      const seen = new Set<string>();
      const snapshots: DaemonServiceSnapshot[] = [];
      for (const { resolvedName, manager } of managers) {
        if (seen.has(resolvedName)) continue;
        seen.add(resolvedName);
        try {
          const status = manager.status();
          snapshots.push({
            serviceName: status.serviceName,
            platform: status.platform,
            unitPath: status.path,
            installed: status.installed === true,
            running: status.running === true,
            startSupported: status.platform !== 'manual',
          });
        } catch (error) {
          // A service manager that cannot answer is "no entry here", said out
          // loud. It is never a reason to fail boot.
          logger.debug('[startup] reading the daemon service entry failed', { serviceName: resolvedName, error: summarizeError(error) });
          snapshots.push({
            serviceName: resolvedName,
            platform: 'unknown',
            unitPath: '',
            installed: false,
            running: false,
            startSupported: false,
          });
        }
      }
      return snapshots;
    },
    start: (serviceName) => {
      const entry = managers.find((candidate) => candidate.resolvedName === serviceName)
        ?? managers.find((candidate) => {
          try {
            return candidate.manager.status().serviceName === serviceName;
          } catch {
            return false;
          }
        });
      if (!entry) return { ok: false, error: `no service entry named "${serviceName}" is tracked on this host` };
      try {
        // `start()` returns a fresh status rather than throwing; `actionError`
        // is where the manager records a refusal.
        const result = entry.manager.start();
        return result.actionError === undefined
          ? { ok: true }
          : { ok: false, error: result.actionError };
      } catch (error) {
        return { ok: false, error: summarizeError(error) };
      }
    },
  };
}

/** Why there was nothing to do. */
export type DaemonAutostartInactionReason =
  | 'daemon-active'
  | 'port-held'
  | 'daemon-disabled'
  /** A probe verdict this policy does not recognise — never treated as recoverable. */
  | 'unrecognized-mode';

/** What the one boot-time recovery step did. */
export type DaemonAutostartOutcome =
  | { readonly action: 'none'; readonly reason: DaemonAutostartInactionReason }
  | { readonly action: 'not-installed' }
  | { readonly action: 'started'; readonly serviceName: string }
  | { readonly action: 'came-online'; readonly serviceName: string }
  | { readonly action: 'start-failed'; readonly serviceName: string; readonly reason: string };

export interface DaemonAutostartOptions {
  /** The probe's verdict for the configured daemon port. */
  readonly daemonMode: string;
  readonly control: DaemonServiceControl;
  /** Is a daemon answering yet? Polled until the bounded wait runs out. */
  readonly isReachable: () => Promise<boolean>;
  readonly waitTimeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Injectable so tests drive the wait loop deterministically. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const DEFAULT_WAIT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

function classifyMode(daemonMode: string): DaemonAutostartInactionReason | 'recoverable' {
  switch (daemonMode) {
    case 'embedded':
    case 'external':
      // A running daemon is never restarted.
      return 'daemon-active';
    case 'blocked':
    case 'incompatible':
      // The port is held — by an unverified process or a daemon this build
      // refuses to adopt. Either way another owner may be mid-update or
      // mid-restart; never fight it.
      return 'port-held';
    case 'disabled':
      return 'daemon-disabled';
    case 'unavailable':
      return 'recoverable';
    default:
      return 'unrecognized-mode';
  }
}

/**
 * Start an installed-but-stopped daemon once, and wait a bounded time for it.
 *
 * Returns what happened rather than throwing: the caller renders it, and a
 * failure here never breaks boot. Pure over its seams — every effect goes
 * through `control` and `isReachable`.
 */
export async function autostartInstalledDaemon(options: DaemonAutostartOptions): Promise<DaemonAutostartOutcome> {
  const classification = classifyMode(options.daemonMode);
  if (classification !== 'recoverable') return { action: 'none', reason: classification };

  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  // Attempt-counted (not wall-clock) so an injected no-op sleep still terminates.
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / pollIntervalMs));

  const waitForAnswer = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(pollIntervalMs);
      try {
        if (await options.isReachable()) return true;
      } catch (error) {
        logger.debug('[startup] re-probing the daemon failed', { error: summarizeError(error) });
      }
    }
    return false;
  };

  const installedEntries = options.control.snapshot().filter((entry) => entry.installed);
  if (installedEntries.length === 0) return { action: 'not-installed' };
  // Prefer a unit already running (wait only), then one this host can actually
  // start, and only then whatever is installed — so a machine carrying both a
  // startable unit and an unstartable one is not refused because of the latter.
  const target = installedEntries.find((entry) => entry.running)
    ?? installedEntries.find((entry) => entry.startSupported)
    ?? installedEntries[0];
  if (!target) return { action: 'not-installed' };

  if (target.running) {
    // The service manager already reports the unit active — it may be mid-start
    // or mid-restart. Wait for it, but never issue another start underneath it.
    if (await waitForAnswer()) return { action: 'came-online', serviceName: target.serviceName };
    return {
      action: 'start-failed',
      serviceName: target.serviceName,
      reason: `service "${target.serviceName}" is active per the service manager but the daemon did not answer within ${waitTimeoutMs}ms — check its logs`,
    };
  }

  if (!target.startSupported) {
    return {
      action: 'start-failed',
      serviceName: target.serviceName,
      reason: `service "${target.serviceName}" is installed without a service-manager entry this surface can start`,
    };
  }

  const started = options.control.start(target.serviceName);
  if (!started.ok) {
    return {
      action: 'start-failed',
      serviceName: target.serviceName,
      reason: started.error ?? 'the service manager refused the start',
    };
  }
  if (await waitForAnswer()) return { action: 'started', serviceName: target.serviceName };
  return {
    action: 'start-failed',
    serviceName: target.serviceName,
    reason: `the service start command was accepted but the daemon did not answer within ${waitTimeoutMs}ms`,
  };
}

/**
 * Render one autostart outcome as the line the user reads.
 *
 * Kept beside the outcome type so the wording and the states it covers cannot
 * drift apart, and so a product's boot path stays a call rather than a switch.
 */
export function describeDaemonAutostart(
  outcome: DaemonAutostartOutcome,
  adoptedAfterwards: boolean,
  adoptionFailureReason?: string | undefined,
): { readonly level: 'low' | 'high'; readonly text: string } | null {
  const suffix = adoptedAfterwards ? '' : ` — but adopting it still failed: ${adoptionFailureReason ?? 'unknown reason'}`;
  switch (outcome.action) {
    case 'started':
      return { level: 'low', text: `[Startup] The daemon was installed but stopped; started it (service "${outcome.serviceName}")${suffix}.` };
    case 'came-online':
      return { level: 'low', text: `[Startup] The daemon service "${outcome.serviceName}" was already starting; connected once it answered${suffix}.` };
    case 'start-failed':
      return { level: 'high', text: `[Startup] The daemon is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it manually with: goodvibes service start` };
    case 'not-installed':
    case 'none':
      return null;
  }
}
