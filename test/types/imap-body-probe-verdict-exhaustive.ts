/**
 * Compile-time pin: "this mailbox was never probed" cannot be read as
 * "the probe came back fine".
 *
 * `docs/inbound-email.md` §3.4d, "Scope sufficiency applies to both": IMAP has
 * no `CAPABILITY` atom that declares body access the way a Gmail scope grant
 * does, so the only way to know whether a mailbox will hand over message
 * content is to ask for some. On an empty mailbox there is nothing to ask
 * for, so `ImapBodyProbeVerdict` has a THIRD case beyond ok/refused:
 * not-probed at all. A tri-state whose "not probed" case reads as falsy is
 * worse than useless here — it is the exact silent-degradation mistake this
 * whole design exists to refuse everywhere else, dressed up as a capability
 * check that looks like it ran.
 *
 * `ImapBodyProbeVerdict` closes that off the same way `ImapIdleSupport`
 * already does in this file's sibling test: `ok` is absent from the
 * `probed: false` case rather than present-and-undefined, so it cannot be
 * read until `probed` has been narrowed to `true`, and a caller either
 * handles "never probed" as its own case or does not compile.
 *
 * Everything below resolves through the PACKAGE NAME rather than a relative
 * path, so this program is built the way a consumer's is.
 *
 * Checked by `bun run types:check`.
 */
import type {
  ImapBodyProbeVerdict,
  ImapConnectionReport,
} from '@pellux/goodvibes-sdk/platform/email';

declare const report: ImapConnectionReport;

// `ok` does not exist AT ALL on the not-probed case — not a `ok` that is
// present and undefined, which would be falsy and would make the truthiness
// read below compile while silently meaning "never asked, treat as fine".
// Pinned as a truthiness read rather than an assignment: an assignment would
// also fail against `boolean | undefined`, and would still pass if the
// property were merely optional rather than genuinely absent.
export function theMistake(): string {
  // @ts-expect-error `ok` does not exist until `probed` is narrowed to `true`
  return report.bodyProbe.ok ? 'confirmed' : 'refused';
}

// The exact failure this file exists to catch: degrading the three-case
// union to a plain boolean loses the distinction between "never asked" and
// "asked and refused" — both would read `false`. Narrowing `probed` first and
// THEN reading `.ok` is the only way through.
export function theDegradedMirror(verdict: ImapBodyProbeVerdict): boolean {
  // @ts-expect-error a bare `ImapBodyProbeVerdict` is not a `boolean` — the
  // whole point is that it cannot be collapsed to one without narrowing first
  const collapsed: boolean = verdict;
  return collapsed;
}

// Narrowing is the only way through, and it forces "never probed" to be a
// case in its own right rather than a falsy stand-in for "refused".
export function describeBodyProbe(verdict: ImapBodyProbeVerdict): string {
  if (!verdict.probed) {
    return 'not probed — the mailbox was empty; the reactive path is the answer';
  }
  return verdict.ok ? 'confirmed at connect' : `refused: ${verdict.detail}`;
}

// A switch over the discriminant, narrowed twice, is exhaustive: a later
// fourth case would fail to compile here rather than fall through to a
// default nobody wrote.
export function bodyProbeLabel(verdict: ImapBodyProbeVerdict): string {
  switch (verdict.probed) {
    case false:
      return 'not-probed';
    case true:
      switch (verdict.ok) {
        case true:
          return 'probed-ok';
        case false:
          return 'probed-refused';
      }
  }
}

export type { ImapConnectionReport };
