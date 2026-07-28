/**
 * Compile-time pin: "this mailbox was never read from" cannot be read as
 * "the probe came back fine".
 *
 * `docs/inbound-email.md` §3.4d, "Scope sufficiency applies to both": IMAP has
 * no `CAPABILITY` atom that declares body access the way a Gmail scope grant
 * does, so the only way to know whether a mailbox will hand over message
 * content is to ask for some. On an empty mailbox there is nothing to ask for,
 * so `ImapBodyProbe` has a THIRD outcome beyond readable/unreadable: nothing
 * was demonstrated at all. An outcome whose "unproven" case reads as falsy is
 * worse than useless here — it is the exact silent-degradation mistake this
 * whole design exists to refuse everywhere else, dressed up as a capability
 * check that looks like it ran.
 *
 * `ImapBodyProbe` closes that off the same way `ImapIdleSupport` already does
 * in this file's sibling test: the evidence for an outcome is absent from the
 * other outcomes rather than present-and-undefined, so it cannot be read until
 * `outcome` has been narrowed, and a caller either handles "nothing was
 * demonstrated" as its own case or does not compile.
 *
 * The evidence for `unreadable` is a union of its own, and pinned here for the
 * same reason. There are two ways to learn an account cannot read bodies — the
 * server withheld a body it had declared, or it refused and named no condition
 * — and they carry different evidence. Collapsing them would put a declared
 * octet count on a refusal that never got as far as a declaration.
 *
 * Everything below resolves through the PACKAGE NAME rather than a relative
 * path, so this program is built the way a consumer's is.
 *
 * Checked by `bun run types:check`.
 */
import type {
  ImapBodyProbe,
  ImapBodyUnreadableEvidence,
  ImapConnectionReport,
} from '@pellux/goodvibes-sdk/platform/email';

declare const probe: ImapBodyProbe;

// `returnedBytes` does not exist AT ALL on the unproven case — not a
// `returnedBytes` that is present and undefined, which would be falsy and would
// make the comparison below compile while silently meaning "never asked, treat
// as fine".
export function theMistake(): string {
  // @ts-expect-error `returnedBytes` does not exist until `outcome` is narrowed
  return probe.returnedBytes > 0 ? 'confirmed' : 'refused';
}

// The exact failure this file exists to catch: degrading the three-outcome
// union to a plain boolean loses the distinction between "nothing was
// demonstrated" and "demonstrated it cannot read" — both would read `false`.
// Narrowing `outcome` first is the only way through.
export function theDegradedMirror(verdict: ImapBodyProbe): boolean {
  // @ts-expect-error a bare `ImapBodyProbe` is not a `boolean` — the whole
  // point is that it cannot be collapsed to one without narrowing first
  const collapsed: boolean = verdict;
  return collapsed;
}

// The evidence is not readable off an unnarrowed probe either: a caller that
// wants to know WHY has to establish `unreadable` first.
export function theEvidenceMistake(): string {
  // @ts-expect-error `evidence` does not exist until `outcome` is 'unreadable'
  return probe.evidence.kind;
}

// Narrowing is the only way through, and it forces "unproven" to be a case in
// its own right rather than a falsy stand-in for "unreadable".
export function describeBodyProbe(verdict: ImapBodyProbe): string {
  if (verdict.outcome === 'unproven') {
    return 'nothing demonstrated — the mailbox was empty; the first message settles it';
  }
  if (verdict.outcome === 'readable') {
    return `confirmed at connect: ${verdict.returnedBytes} byte(s)`;
  }
  return `cannot read message content: ${describeEvidence(verdict.evidence)}`;
}

// The evidence union narrows the same way, and each arm can only read the
// field its own case actually carries.
export function describeEvidence(evidence: ImapBodyUnreadableEvidence): string {
  switch (evidence.kind) {
    case 'withheld':
      return `the server declared ${evidence.declaredOctets} octet(s) and returned none`;
    case 'refused':
      return `the server refused: ${evidence.serverMessage}`;
  }
}

// A declared octet count is meaningless for a refusal that never reached a
// declaration, so it is absent rather than zero.
export function theCrossedEvidence(evidence: ImapBodyUnreadableEvidence): number {
  if (evidence.kind === 'refused') {
    // @ts-expect-error a refusal carries no declaration to report
    return evidence.declaredOctets;
  }
  return evidence.declaredOctets;
}

// A switch over the discriminant is exhaustive: a later fourth outcome would
// fail to compile here rather than fall through to a default nobody wrote.
export function bodyProbeLabel(verdict: ImapBodyProbe): string {
  switch (verdict.outcome) {
    case 'unproven':
      return 'unproven';
    case 'readable':
      return 'readable';
    case 'unreadable':
      return 'unreadable';
  }
}

export type { ImapConnectionReport };
