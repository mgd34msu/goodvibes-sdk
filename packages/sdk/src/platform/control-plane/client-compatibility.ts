/**
 * Client build compatibility floor.
 *
 * A daemon update swaps the daemon binary. It does NOT restart the clients
 * already attached to it: a terminal UI or agent process started days earlier
 * keeps running its old build, keeps heartbeating into the shared session
 * store, and keeps executing shared-session work with whatever rules that old
 * build shipped with. A behavioral fix landed in the daemon is therefore
 * INVISIBLE for as long as one stale client is still attached, the old build
 * simply does the old thing beside the new one, and the two are
 * indistinguishable from the outside except by which host their notification
 * links point at.
 *
 * That is what this floor is for. The daemon publishes the minimum client
 * build it will let participate; every client compares its own build against
 * it on attach and, when it is below the floor, says so plainly and stops
 * claiming ownership of shared sessions rather than quietly executing work
 * under superseded rules.
 *
 * The floor is announced as a RESPONSE HEADER on `/status` rather than as a
 * body field: `/status` has a closed response schema, and a header is
 * additive, ignorable by older clients, and readable from the liveness probe
 * every client already performs.
 */

/** Response header carrying the daemon's minimum acceptable client build. */
export const CLIENT_COMPATIBILITY_FLOOR_HEADER = 'X-Goodvibes-Client-Floor';

/**
 * The minimum client build this daemon accepts as a full participant.
 *
 * 1.14.0 is the release in which the conversation-first spawn gate exists at
 * all. A client below it, handed a shared session, will open a review chain
 * for a one-word message because its build has no gate to consult, which is
 * exactly the production failure this floor exists to stop repeating.
 *
 * Raise this only for a behavioral change a client MUST have. It costs a
 * restart for anyone running an older build.
 */
export const CLIENT_COMPATIBILITY_FLOOR = '1.14.0';

export type ClientCompatibilityStatus = 'ok' | 'restart-required' | 'unknown';

export interface ClientCompatibilityVerdict {
  readonly status: ClientCompatibilityStatus;
  /** One plain line naming the real situation, for a log or a notice. */
  readonly message: string;
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}

/**
 * Compare two dotted build versions numerically, segment by segment.
 * Returns <0, 0, >0. Pre-release suffixes ("1.14.0-rc.1") compare on their
 * numeric prefix, so a release candidate is treated as its release, this
 * gates on behavior, and an rc carries the behavior.
 */
export function compareBuildVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((segment) => Number.parseInt(segment, 10))
      .filter((segment) => Number.isFinite(segment));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Judge a client build against a floor.
 *
 * An unparseable or absent client version is 'unknown', NOT 'ok': the point of
 * the floor is that a build which cannot prove it carries a required behavior
 * is treated as one that does not. An absent FLOOR is a different thing, a
 * daemon too old to publish one, and yields 'ok', because that daemon is not
 * asking for anything.
 */
export function evaluateClientCompatibility(input: {
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}): ClientCompatibilityVerdict {
  const floor = input.floor?.trim();
  const clientVersion = input.clientVersion?.trim();
  if (!floor) {
    return {
      status: 'ok',
      message: 'The daemon publishes no client build floor; nothing to check.',
      clientVersion,
      floor: undefined,
    };
  }
  if (!clientVersion || !/\d/.test(clientVersion)) {
    return {
      status: 'unknown',
      message: `This build does not report a version, so it cannot be checked against the daemon's floor of ${floor}. Restart it from the current install to be sure it is current.`,
      clientVersion,
      floor,
    };
  }
  if (compareBuildVersions(clientVersion, floor) < 0) {
    return {
      status: 'restart-required',
      message: `This process is running build ${clientVersion}; the daemon requires ${floor} or newer. It has stopped taking shared-session work, restart it to rejoin.`,
      clientVersion,
      floor,
    };
  }
  return {
    status: 'ok',
    message: `Build ${clientVersion} meets the daemon's floor of ${floor}.`,
    clientVersion,
    floor,
  };
}

/** Read the floor a daemon announced, from any `/status` response headers. */
export function readClientCompatibilityFloor(
  headers: { get(name: string): string | null } | undefined,
): string | undefined {
  const value = headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER)
    ?? headers?.get(CLIENT_COMPATIBILITY_FLOOR_HEADER.toLowerCase());
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
