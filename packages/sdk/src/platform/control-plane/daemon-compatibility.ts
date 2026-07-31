/**
 * Daemon build compatibility floor — the reverse of client-compatibility.ts.
 *
 * That module is the DAEMON's half of the handshake: the daemon publishes the
 * oldest client build it will let participate, and a client that falls below it
 * stops claiming shared-session work. This module is the CLIENT's half.
 *
 * A pure client has the same exposure in the other direction. It talks to a
 * daemon it did not start and cannot see, over a base URL that may point at
 * another machine, and every capability it has is something the daemon performs
 * on its behalf. A verb the client depends on may simply not exist in the build
 * that answers — and what the client observes when that happens is a 400 or a
 * 404 on one call, which reads as a broken feature rather than as an old
 * daemon. The client then keeps running, half-working, against a peer it has no
 * reason to suspect.
 *
 * So a client declares the oldest daemon build it can work against and checks
 * it once, on attach, against the version `/status` already returns
 * (daemon-sdk/control-routes.ts `getStatus` → `{ status, version, … }`). Below
 * the floor it refuses with a sentence naming both versions and the one action
 * that fixes it, exactly as the settings reader-floor refusal does
 * (config/settings-reader-floor.ts `describeFloorRefusal`) — because the key or
 * the verb that happened to fail is the symptom and the version is the cause.
 *
 * The floor is the CONSUMER's, not the SDK's: the TUI, the agent and the web UI
 * need different daemon behaviors at different times, and a single SDK-wide
 * constant would either over-refuse for one of them or under-refuse for another.
 * Each consumer passes its own and states, in its own release notes, what it
 * raised the floor for.
 */

import { compareBuildVersions } from './client-compatibility.js';

export type DaemonCompatibilityStatus = 'ok' | 'daemon-update-required' | 'unknown';

export interface DaemonCompatibilityVerdict {
  readonly status: DaemonCompatibilityStatus;
  /** One plain line naming the real situation, for a log, a banner or a refusal. */
  readonly message: string;
  readonly daemonVersion: string | undefined;
  readonly floor: string | undefined;
}

/**
 * The daemon build reported by a `/status` response body.
 *
 * Reads the body rather than a header, deliberately: `/status` has carried
 * `version` since the route existed, so every daemon a client can reach already
 * answers this — no new endpoint, no contract change, and no dependence on a
 * build new enough to have added a header. A body that is not an object, or
 * carries no usable `version`, yields undefined rather than a guess.
 */
export function readDaemonVersion(statusPayload: unknown): string | undefined {
  if (statusPayload === null || typeof statusPayload !== 'object' || Array.isArray(statusPayload)) {
    return undefined;
  }
  const version = (statusPayload as Record<string, unknown>)['version'];
  if (typeof version !== 'string') return undefined;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Judge the daemon a client is attached to against the client's own floor.
 *
 * The three outcomes mirror `evaluateClientCompatibility`, including the part
 * that matters most: a daemon whose version cannot be read is 'unknown', NOT
 * 'ok'. A build that cannot prove it carries a required behavior is treated as
 * one that does not. An absent FLOOR is a different thing — a client that is
 * not asking for anything — and yields 'ok'.
 *
 * `daemonLabel` names the peer in the sentence (a base URL, a host name) so an
 * operator with two daemons on the LAN learns WHICH one is old. Absent, the
 * sentence says "the daemon".
 */
export function evaluateDaemonCompatibility(input: {
  readonly daemonVersion: string | undefined;
  readonly floor: string | undefined;
  readonly daemonLabel?: string | undefined;
}): DaemonCompatibilityVerdict {
  const floor = input.floor?.trim();
  const daemonVersion = input.daemonVersion?.trim();
  const label = input.daemonLabel?.trim();
  const peer = label && label.length > 0 ? `The daemon at ${label}` : 'The daemon';
  if (!floor) {
    return {
      status: 'ok',
      message: 'This client declares no daemon build floor; nothing to check.',
      daemonVersion,
      floor: undefined,
    };
  }
  if (!daemonVersion || !/\d/.test(daemonVersion)) {
    return {
      status: 'unknown',
      message: `${peer} did not report a version, so it cannot be checked against this client's floor of ${floor}. Update the daemon to be sure it is current.`,
      daemonVersion,
      floor,
    };
  }
  if (compareBuildVersions(daemonVersion, floor) < 0) {
    return {
      status: 'daemon-update-required',
      message: `${peer} is running build ${daemonVersion}; this client requires ${floor} or newer — update the daemon.`,
      daemonVersion,
      floor,
    };
  }
  return {
    status: 'ok',
    message: `${peer} is running build ${daemonVersion}, which meets this client's floor of ${floor}.`,
    daemonVersion,
    floor,
  };
}

/**
 * The one-shot form: hand it a parsed `/status` body and a floor, get a verdict.
 *
 * The shape a client attaching to a daemon actually has — it already probes
 * `/status` for liveness — so adopting the check is one call at the site that
 * probe returns to, rather than a version field a consumer has to remember to
 * pull out first.
 */
export function evaluateDaemonStatusCompatibility(
  statusPayload: unknown,
  floor: string | undefined,
  daemonLabel?: string | undefined,
): DaemonCompatibilityVerdict {
  return evaluateDaemonCompatibility({
    daemonVersion: readDaemonVersion(statusPayload),
    floor,
    ...(daemonLabel === undefined ? {} : { daemonLabel }),
  });
}
