/**
 * install-provision.ts — putting the wake-word model on disk AS PART OF
 * INSTALLING, and retrying it at boot.
 *
 * WHY THIS EXISTS
 *
 * Everything needed to run the detector was already here — a pinned classifier,
 * a front end computed in code, a verified download, recovery housekeeping — and
 * a fresh machine had none of it. Provisioning was reachable only by typing
 * `/voice wake setup` or calling `voice.wake.provision`, so the ordinary
 * outcome of installing goodvibes was a wake-word feature that could not start,
 * with a model most people would never go and fetch. The model ships with the
 * installation now. This module is the policy that makes that safe.
 *
 * THE THREE RULES IT ENFORCES
 *
 *  1. **AN INSTALL NEVER FAILS OVER THIS.** Every call returns an outcome; none
 *     throws, on any input, including a network that is not there, a DNS failure,
 *     a proxy serving HTML, a read-only home directory, or a pin that resolves to
 *     nothing. A wake-word model is not a reason to fail installing a coding
 *     tool, and an installer that aborts half-way is worse than one without a
 *     wake word. A failed fetch degrades to EXACTLY the old behaviour: status
 *     reports not-provisioned by content, and the recovery command still works.
 *
 *  2. **IT SAYS SO ONCE, PLAINLY.** {@link WakeInstallProvisionOutcome.message}
 *     is one line of prose a caller prints or logs verbatim. Not a stack trace,
 *     not a silent log entry at debug level, and not repeated per artifact — the
 *     failure mode being avoided is a user whose wake word does not work and who
 *     has no idea a download was ever attempted.
 *
 *  3. **IT REAPS BEFORE IT RETRIES.** A previous attempt may have been killed
 *     mid-download. So a run sweeps first (recovery.ts): abandoned partials go,
 *     and anything present that does not hash to its pin is removed rather than
 *     re-used. That is what makes the boot retry converge instead of inspecting
 *     the same torn file every morning.
 *
 * WHAT IS STILL NOT AUTOMATIC
 *
 * Turning `voice.wake.enabled` on downloads nothing, and neither does reading
 * status. Those paths are read-only and report not-provisioned with the recovery
 * command named. Installing, and booting a daemon that was installed, are the
 * sanctioned acts — each with a written receipt — and they are the only ones.
 */
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  provisionWakeWordModels,
  wakeProvisionStatus,
  type WakeComponentOutcome,
  type WakeProvisionOptions,
  type WakeProvisionResult,
  type WakeProvisionStatus,
} from './provisioning.js';
import {
  startWakeRecoverySweeper,
  sweepWakeStorage,
  WAKE_SWEEP_INTERVAL_MS,
  type WakeReapSummary,
  type WakeRecoveryOptions,
  type WakeRecoverySweeper,
} from './recovery.js';

/**
 * Set this to `1` (or `true`) to install without the wake-word model.
 *
 * A real switch rather than an undocumented behaviour: an air-gapped build host,
 * a CI image that should not pull 6 MB per install, or a user who simply does not
 * want the feature all have the same legitimate need. Opting out is reported in
 * the outcome message together with how to get the model later, so it is never
 * indistinguishable from a silent failure.
 */
export const WAKE_INSTALL_SKIP_ENV = 'GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD';

/**
 * The recovery act named in a degraded message when the caller does not supply a
 * surface-specific one. The control-plane verb, because it is the same on every
 * surface; a terminal passes `/voice wake setup` instead.
 */
export const WAKE_INSTALL_DEFAULT_RECOVERY_HINT = 'the voice.wake.provision verb';

/**
 * How long one install-time provision may take before it is abandoned.
 *
 * Shorter than the 10 minutes {@link provisionWakeWordModels} allows by default,
 * because the caller here is an installer or a booting daemon: a black-holed
 * connection must degrade in a couple of minutes, not hold an install open for
 * ten. Abandoning is safe — nothing partial is kept, and the next boot retries.
 */
export const WAKE_INSTALL_TIMEOUT_MS = 120_000;

/** Delay before a boot-time attempt starts, so it never sits in front of startup. */
export const WAKE_BOOT_PROVISION_DELAY_MS = 5_000;

/** What one install/boot provisioning attempt concluded. */
export type WakeInstallProvisionState =
  /** Content-verified before anything was attempted; nothing was fetched. */
  | 'already-provisioned'
  /** Fetched and verified during this run: the detector can start now. */
  | 'provisioned'
  /** Attempted and did not land. Installation continues; the feature reports not-provisioned. */
  | 'degraded'
  /** {@link WAKE_INSTALL_SKIP_ENV} asked for no download. */
  | 'opted-out';

export interface WakeInstallProvisionOutcome {
  readonly state: WakeInstallProvisionState;
  /** Content-verified after the attempt: is the DETECTOR able to start. */
  readonly ready: boolean;
  /** The tflite twin also landed, so the daemon can serve that form. */
  readonly mobileFormatReady: boolean;
  /** One plain line for the caller to print or log verbatim. Never empty. */
  readonly message: string;
  /** Per-artifact outcomes when a fetch was attempted; empty otherwise. */
  readonly outcomes: readonly WakeComponentOutcome[];
  readonly modelVersion: string | null;
  /** Artifacts the pre-attempt sweep removed (torn files, abandoned partials). */
  readonly reapedBeforeAttempt: number;
}

export interface WakeInstallProvisionOptions {
  /** The managed voice root; wake artifacts live in its `wake` subdirectory. */
  readonly managedRoot: string;
  /** Model version to provision. Defaults to the manifest's pinned default. */
  readonly version?: string | undefined;
  /** Named in a degraded message. Defaults to {@link WAKE_INSTALL_DEFAULT_RECOVERY_HINT}. */
  readonly recoveryHint?: string | undefined;
  /** Environment to read the opt-out from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Provisioner seam, so a test never downloads. */
  readonly provision?: ((options: WakeProvisionOptions) => Promise<WakeProvisionResult>) | undefined;
  /** Status-read seam, paired with `provision`. */
  readonly readStatus?: ((options: { managedRoot: string; version?: string | undefined }) => WakeProvisionStatus) | undefined;
  /** Pre-attempt sweep seam. */
  readonly sweep?: ((options: WakeRecoveryOptions) => WakeReapSummary) | undefined;
}

function optedOut(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = (env[WAKE_INSTALL_SKIP_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Bytes as a short human figure, for the one message this module emits. */
function describeBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

/**
 * The honest reason a degraded run failed, taken from the first artifact that
 * did not land rather than invented. "no reason reported" would be a bug, not a
 * state, so it is only the last resort.
 */
function firstFailure(outcomes: readonly WakeComponentOutcome[]): string {
  for (const outcome of outcomes) {
    if (outcome.state === 'failed') return outcome.error ?? `${outcome.component} failed with no reason reported`;
  }
  return 'no artifact reported a failure, yet verification still does not pass';
}

/**
 * Provision the wake-word artifacts as part of an install or a boot.
 *
 * NEVER THROWS. Every failure path — an absent network, an unwritable directory,
 * a provisioner that itself threw — comes back as a `degraded` outcome whose
 * message names what happened and how to retry. Callers are installers; an
 * exception here is an aborted installation.
 */
export async function provisionWakeWordModelsAtInstall(
  options: WakeInstallProvisionOptions,
): Promise<WakeInstallProvisionOutcome> {
  const readStatus = options.readStatus ?? wakeProvisionStatus;
  const hint = options.recoveryHint ?? WAKE_INSTALL_DEFAULT_RECOVERY_HINT;
  const versionOption = options.version === undefined ? {} : { version: options.version };

  // Even reading status touches the filesystem, so it is inside the guard too.
  let before: WakeProvisionStatus;
  try {
    before = readStatus({ managedRoot: options.managedRoot, ...versionOption });
  } catch (error) {
    return {
      state: 'degraded',
      ready: false,
      mobileFormatReady: false,
      message:
        `The wake-word model could not be checked (${summarizeError(error)}); installation continues. `
        + `Wake-word detection reports not-provisioned until it is fetched — run ${hint} to retry.`,
      outcomes: [],
      modelVersion: null,
      reapedBeforeAttempt: 0,
    };
  }

  if (before.ready && before.mobileClassifier.verified) {
    return {
      state: 'already-provisioned',
      ready: true,
      mobileFormatReady: true,
      message: `The wake-word model is already present and verified (${before.modelVersion ?? 'unpinned'}); nothing was downloaded.`,
      outcomes: [],
      modelVersion: before.modelVersion,
      reapedBeforeAttempt: 0,
    };
  }

  if (optedOut(options.env ?? process.env)) {
    return {
      state: 'opted-out',
      ready: before.ready,
      mobileFormatReady: before.mobileClassifier.verified,
      message:
        `The wake-word model was not downloaded because ${WAKE_INSTALL_SKIP_ENV} is set. `
        + `Wake-word detection reports not-provisioned until it is fetched — run ${hint} whenever you want it.`,
      outcomes: [],
      modelVersion: before.modelVersion,
      reapedBeforeAttempt: 0,
    };
  }

  // Reap first. An attempt killed mid-download leaves a partial, and a torn file
  // that is never removed is a boot retry that never converges.
  let reapedBeforeAttempt = 0;
  try {
    const sweep = (options.sweep ?? sweepWakeStorage)({
      managedRoot: options.managedRoot,
      ...versionOption,
      // No receipt for a pre-attempt tidy-up: the receipt this run owes the user
      // is its own outcome message, and the periodic sweeper writes the reap one.
      skipReceipt: true,
    });
    reapedBeforeAttempt = sweep.reaped.length;
  } catch (error) {
    // A sweep that failed is not a reason to skip the download — the download
    // re-verifies every file it touches anyway.
    logger.warn('wake install provisioning: pre-attempt sweep failed', { error: summarizeError(error) });
  }

  let result: WakeProvisionResult;
  try {
    result = await (options.provision ?? provisionWakeWordModels)({
      managedRoot: options.managedRoot,
      ...versionOption,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: options.timeoutMs ?? WAKE_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      state: 'degraded',
      ready: false,
      mobileFormatReady: false,
      message:
        `The wake-word model could not be downloaded (${summarizeError(error)}); installation continues. `
        + `Wake-word detection reports not-provisioned until it is fetched — run ${hint} to retry, `
        + 'or leave it and the next daemon start tries again.',
      outcomes: [],
      modelVersion: before.modelVersion,
      reapedBeforeAttempt,
    };
  }

  // The provisioner's own receipt is not the last word: verify what is on disk,
  // by content, exactly as every other reader of this tree does.
  let after: WakeProvisionStatus;
  try {
    after = readStatus({ managedRoot: options.managedRoot, ...versionOption });
  } catch {
    after = before;
  }

  if (!after.ready) {
    return {
      state: 'degraded',
      ready: false,
      mobileFormatReady: after.mobileClassifier.verified,
      message:
        `The wake-word model could not be downloaded (${firstFailure(result.outcomes)}); installation continues. `
        + `Wake-word detection reports not-provisioned until it is fetched — run ${hint} to retry, `
        + 'or leave it and the next daemon start tries again.',
      outcomes: result.outcomes,
      modelVersion: result.modelVersion ?? before.modelVersion,
      reapedBeforeAttempt,
    };
  }

  const installed = result.outcomes
    .filter((outcome) => outcome.state === 'installed')
    .reduce((total, outcome) => total + (outcome.bytes ?? 0), 0);
  const mobileNote = after.mobileClassifier.verified
    ? ''
    : ' The mobile (tflite) form of the same classifier did not land, which affects nothing this host runs.';
  return {
    state: 'provisioned',
    ready: true,
    mobileFormatReady: after.mobileClassifier.verified,
    message:
      `Wake-word model installed and verified: "hey goodvibes" ${after.modelVersion ?? 'unpinned'}`
      + `${installed > 0 ? ` (${describeBytes(installed)})` : ''}. `
      + 'Turn it on with voice.wake.enabled — nothing further to download.'
      + mobileNote,
    outcomes: result.outcomes,
    modelVersion: after.modelVersion,
    reapedBeforeAttempt,
  };
}

/** A running boot-provisioning + housekeeping pair. */
export interface WakeBootProvisioning {
  /** The periodic recovery sweeper this started, for a caller that wants a sweep now. */
  readonly sweeper: WakeRecoverySweeper;
  /** Stop the sweep schedule and cancel a pending first attempt. Idempotent. */
  stop(): void;
}

export interface WakeBootProvisioningOptions {
  readonly managedRoot: string;
  /**
   * The provisioning attempt, injected rather than called directly, so a host
   * routes it through ITS single-flight — a boot attempt and a user typing the
   * setup command at the same moment must join one download, not race.
   */
  readonly ensureProvisioned: () => Promise<WakeInstallProvisionOutcome>;
  /** Where the one message goes. Called at most once per boot. */
  readonly announce: (message: string) => void;
  /** Delay before the attempt. Defaults to {@link WAKE_BOOT_PROVISION_DELAY_MS}. */
  readonly startDelayMs?: number | undefined;
  /** Recovery sweep interval. Defaults to the recovery module's own. */
  readonly sweepIntervalMs?: number | undefined;
  /** Live session ids, so retained wake clips of dead sessions are reaped. */
  readonly liveSessionIds?: (() => readonly string[]) | undefined;
  readonly setTimeoutImpl?: ((handler: () => void, ms: number) => unknown) | undefined;
  readonly clearTimeoutImpl?: ((handle: unknown) => void) | undefined;
}

/**
 * Start the boot half: sweep the wake tree now and on a schedule, then make one
 * provisioning attempt for whatever the install could not get.
 *
 * The attempt is delayed and never awaited, so a daemon's startup is not held
 * behind a download, and it announces only when there is something to say — a
 * host that is already provisioned stays silent rather than logging a line about
 * doing nothing on every restart.
 */
export function startWakeBootProvisioning(options: WakeBootProvisioningOptions): WakeBootProvisioning {
  const sweeper = startWakeRecoverySweeper({
    managedRoot: options.managedRoot,
    ...(options.liveSessionIds !== undefined ? { liveSessionIds: options.liveSessionIds() } : {}),
    ...(options.sweepIntervalMs !== undefined ? { intervalMs: options.sweepIntervalMs } : { intervalMs: WAKE_SWEEP_INTERVAL_MS }),
  });
  const setTimeoutImpl = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });

  let stopped = false;
  const handle = setTimeoutImpl(() => {
    if (stopped) return;
    void options.ensureProvisioned().then((outcome) => {
      if (stopped) return;
      // Silent on the boring case. A restart of an already-provisioned daemon
      // has nothing to tell anyone.
      if (outcome.state === 'already-provisioned') return;
      options.announce(outcome.message);
    }).catch((error: unknown) => {
      // ensureProvisioned is contracted not to throw; if a host's wrapper does,
      // that is the host's bug and it must not take the daemon down with it.
      logger.warn('wake boot provisioning attempt threw', { error: summarizeError(error) });
    });
  }, options.startDelayMs ?? WAKE_BOOT_PROVISION_DELAY_MS);
  // Housekeeping never holds a process open.
  (handle as { unref?: () => void } | undefined)?.unref?.();

  return {
    sweeper,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeoutImpl(handle);
      sweeper.stop();
    },
  };
}
