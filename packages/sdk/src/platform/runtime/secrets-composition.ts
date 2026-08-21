/**
 * secrets-composition.ts, building the credential store with its homes wired
 * to the ones the host was actually told about.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * `SecretsManagerOptions.daemonHome` has always existed, and its own doc says
 * a caller honouring `--daemon-home` or `GOODVIBES_DAEMON_HOME` should resolve
 * it and pass it here. No composition root ever did.
 *
 * So "isolating" a daemon by giving it `--daemon-home /tmp/...` moved its
 * identity directory and nothing else. Its credential store stayed at
 * `<realHome>/.goodvibes/daemon`, and when that held nothing the read order
 * walks the working directory's ancestors, which, for any process running
 * under the owner's home, reaches the owner's real project secret store.
 *
 * A throwaway daemon therefore held the owner's real credentials. One of them
 * long-polled the owner's real Telegram bot, collided with the production
 * daemon on the same token, and inbound messages stopped.
 *
 * Passing the override through is the fix, and it belongs in one named place
 * rather than repeated at each composition root, because the failure mode is
 * silent: nothing breaks when it is forgotten, the daemon simply reads
 * somebody else's secrets.
 *
 * Note what this does NOT fix, deliberately: a `daemonHome` override does not
 * relocate the project/user tiers, and it should not, those are genuinely
 * addressed by `projectRoot` and `globalHome`. Isolating a daemon completely
 * means moving all three outside the real home, which is why
 * `describeSecretIsolation` reports what is and is not isolated rather than
 * implying one flag is enough.
 */

import { SecretsManager, type SecretsManagerOptions } from '../config/secrets.js';

export interface DaemonSecretsCompositionInput {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly surfaceRoot: string;
  readonly configManager: SecretsManagerOptions['configManager'];
  /**
   * The daemon state root the host was told to use, when it was told one.
   * Absent means the machine default (`<globalHome>/.goodvibes/daemon`).
   */
  readonly daemonHome?: string | undefined;
}

/** Construct the credential store, honouring a daemon-home override. */
export function createRuntimeSecretsManager(input: DaemonSecretsCompositionInput): SecretsManager {
  return new SecretsManager({
    projectRoot: input.projectRoot,
    globalHome: input.globalHome,
    surfaceRoot: input.surfaceRoot,
    configManager: input.configManager,
    ...(input.daemonHome === undefined ? {} : { daemonHome: input.daemonHome }),
  });
}

/** Which credential tiers a given composition actually moved off the real home. */
export interface SecretIsolationReport {
  readonly daemonTierIsolated: boolean;
  readonly projectTierIsolated: boolean;
  readonly userTierIsolated: boolean;
  /** True only when a real credential in the machine home is unreachable. */
  readonly fullyIsolated: boolean;
  /** Plain-language summary naming whichever tier still points at the real home. */
  readonly detail: string;
}

function isUnder(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, '');
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/**
 * Report honestly whether a composition is isolated from the machine's real
 * credentials.
 *
 * Written as a report rather than a boolean because the interesting answer is
 * WHICH tier leaked: a harness that overrode the daemon home and left the
 * project root under the real home is the exact configuration that read the
 * owner's token, and "isolated: false" alone would not have said why.
 */
export function describeSecretIsolation(input: {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly daemonHome?: string | undefined;
  /** The machine's real home directory to compare against. */
  readonly machineHome: string;
}): SecretIsolationReport {
  const daemonHome = input.daemonHome ?? `${input.globalHome.replace(/\/+$/, '')}/.goodvibes/daemon`;
  const daemonTierIsolated = !isUnder(daemonHome, input.machineHome);
  // The read order walks EVERY ancestor of the project root, so a project root
  // anywhere beneath the machine home reaches its stores.
  const projectTierIsolated = !isUnder(input.projectRoot, input.machineHome);
  const userTierIsolated = !isUnder(input.globalHome, input.machineHome);
  const fullyIsolated = daemonTierIsolated && projectTierIsolated && userTierIsolated;

  const leaking = [
    daemonTierIsolated ? null : 'the daemon tier',
    projectTierIsolated ? null : 'the project tier (its ancestors reach the real home)',
    userTierIsolated ? null : 'the user tier',
  ].filter((entry): entry is string => entry !== null);

  return {
    daemonTierIsolated,
    projectTierIsolated,
    userTierIsolated,
    fullyIsolated,
    detail: fullyIsolated
      ? 'no credential store resolves inside the machine home'
      : `still reads the machine home through ${leaking.join(' and ')}`,
  };
}
