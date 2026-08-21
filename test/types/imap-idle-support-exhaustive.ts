/**
 * Compile-time pin: "the server said nothing about IDLE" cannot be read as
 * "the server does not support IDLE".
 *
 * The connection report used to carry `supportsIdle: boolean | null`, and the
 * distinction it was drawing is a real one, a server that never listed its
 * capabilities has not told us it lacks IDLE. But a tri-state whose third
 * value is falsy is worse than a boolean, because it looks careful and behaves
 * carelessly: `if (report.supportsIdle)` compiled, and quietly meant "poll
 * forever against a server that supports push". The mistake is invisible at the
 * call site and produces no error anywhere, the watcher simply never uses the
 * capability it has.
 *
 * `ImapIdleSupport` closes that off structurally rather than by documentation.
 * `supported` is absent from the unknown case rather than present-and-
 * undefined, so it cannot be reached until `known` has been narrowed, and a
 * caller either handles "the server said nothing" or does not compile.
 *
 * Everything below resolves through the PACKAGE NAME rather than a relative
 * path, so this program is built the way a consumer's is.
 *
 * Checked by `bun run types:check`.
 */
import type {
  ImapConnectionReport,
  ImapIdleSupport,
} from '@pellux/goodvibes-sdk/platform/email';

declare const report: ImapConnectionReport;

// The unknown case has no `supported` to read AT ALL, not a `supported` that
// is present and undefined, which would be falsy and would make the truthiness
// test below compile and silently mean "poll forever". This is the whole
// point, so it is pinned as a truthiness read rather than an assignment: an
// assignment would also fail against `boolean | undefined`, and would still
// pass if the property were merely optional.
export function theMistake(): string {
  // @ts-expect-error `supported` does not exist until `known` is narrowed
  return report.idle.supported ? 'push' : 'poll';
}

// Narrowing is the only way through, and it forces the unknown case to be a
// case rather than a falsy value.
export function describeIdle(support: ImapIdleSupport): string {
  if (!support.known) {
    return 'the server did not say, ask with resolveIdleSupport()';
  }
  return support.supported ? 'IDLE is advertised' : 'IDLE is not advertised';
}

// A switch over the discriminant is exhaustive, so a later third case would
// fail to compile here rather than fall through to a default nobody wrote.
export function idleLabel(support: ImapIdleSupport): string {
  switch (support.known) {
    case true:
      return support.supported ? 'push' : 'poll';
    case false:
      return 'unknown';
  }
}

export type { ImapConnectionReport };
