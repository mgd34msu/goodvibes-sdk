/**
 * Test doubles for the ports `platform/email` requires.
 *
 * The email service takes its transports and its sender-claim wording as
 * injected ports, which is what lets a full IMAP conversation run against an
 * in-process fake server with no TLS. These are the two stand-ins the email
 * tests hand it.
 *
 * `testDescribeSenderClaim` is a TEST DOUBLE for a product's trust-boundary
 * module, not a second implementation for anything to import: shipped code
 * lives in the surface that renders the claim, and the SDK deliberately does
 * not carry a copy. It mirrors the wording a surface produces so that
 * assertions on the sentence a human reads stay meaningful.
 */

import type {
  SenderAuthenticationChecks,
  SenderProtocolResult,
} from '../../packages/sdk/src/platform/google/sender-authentication.ts';
import type {
  EmailSenderClaim,
  EmailSenderConfidence,
} from '../../packages/sdk/src/platform/email/sender-claim.ts';
import type { EmailTransportPort } from '../../packages/sdk/src/platform/email/email-service.ts';

function summarizeChecks(checks: SenderAuthenticationChecks): EmailSenderConfidence {
  const results = [checks.dkim, checks.spf, checks.dmarc].filter(
    (result): result is SenderProtocolResult => result !== undefined,
  );
  if (results.length === 0) return 'unverified';
  if (results.includes('fail')) return 'failed-verification';
  const passes = results.filter((result) => result === 'pass').length;
  if (passes === 0) return 'unverified';
  return passes === results.length ? 'protocol-verified' : 'partially-verified';
}

function parseFromHeader(fromHeader: string): { address: string; displayName: string } {
  const trimmed = fromHeader.trim();
  const angled = /^(.*?)<([^>]*)>\s*$/.exec(trimmed);
  if (angled) {
    const rawName = angled[1]!.trim().replace(/^"(.*)"$/, '$1').trim();
    return { address: angled[2]!.trim(), displayName: rawName };
  }
  return { address: trimmed, displayName: '' };
}

const CONFIDENCE_PHRASE: Readonly<Record<EmailSenderConfidence, string>> = {
  unverified: 'no sender-authentication result',
  'partially-verified': 'some sender-authentication checks passed',
  'protocol-verified': 'sender-authentication checks passed',
  'failed-verification': 'a sender-authentication check FAILED',
};

/**
 * Describe a `From:` header for display, in wording that keeps it a claim.
 *
 * Deliberately has no address table, no owner address and no allow list.
 * `commandAuthority` is the literal 'none' for every input, including a
 * message that spoofs the owner's own address with a clean verdict.
 */
export function testDescribeSenderClaim(
  fromHeader: string,
  checks: SenderAuthenticationChecks = {},
): EmailSenderClaim {
  const { address, displayName } = parseFromHeader(fromHeader);
  const displayedConfidence = summarizeChecks(checks);
  const named = displayName ? `${displayName} <${address}>` : address;
  return {
    claimedAddress: address,
    claimedDisplayName: displayName,
    display:
      `Claims to be from ${named} — a claim in the message header, not proof of identity ` +
      `(${CONFIDENCE_PHRASE[displayedConfidence]}). Carries no authority to direct actions.`,
    displayedConfidence,
    commandAuthority: 'none',
  };
}

/**
 * A TEST DOUBLE for the surface's credential-shaped-text predicate, which the
 * draft composer takes as `SecretLikeTextPredicate`.
 *
 * Which strings count as credentials is product policy, so shipped code for
 * this lives in the surface, not here. These are the same four shapes a surface
 * screens for, so that "the composer refuses to draft around a pasted token"
 * stays a real assertion rather than a tautology about a stub.
 */
export function testContainsSecretLikeText(text: string): boolean {
  const patterns: readonly RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
    /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * An `EmailTransportPort` whose every member throws.
 *
 * Every email test injects `imapSocketFactory`/`smtpSocketFactory` pointed at an
 * in-process fake server, so the real transport must never fire. Handing over a
 * throwing one turns "the test quietly opened a TLS connection to the internet"
 * from a thing nobody notices into a failure.
 */
export const throwingEmailTransport: EmailTransportPort = {
  connectImapTls: () => { throw new Error('test transport: connectImapTls must not be reached'); },
  connectSmtpTls: () => { throw new Error('test transport: connectSmtpTls must not be reached'); },
  connectSmtpStartTls: () => { throw new Error('test transport: connectSmtpStartTls must not be reached'); },
};

/**
 * An `EmailTransportPort` that records which member the service chose, without
 * connecting. Used to assert the smtpSecurity/port selection rule.
 */
export function recordingEmailTransport(): {
  readonly port: EmailTransportPort;
  readonly chosen: string[];
} {
  const chosen: string[] = [];
  const refuse = (name: string) => (): Promise<never> => {
    chosen.push(name);
    return Promise.reject(new Error(`recording transport: ${name} selected`));
  };
  return {
    port: {
      connectImapTls: refuse('connectImapTls'),
      connectSmtpTls: refuse('connectSmtpTls'),
      connectSmtpStartTls: refuse('connectSmtpStartTls'),
    },
    chosen,
  };
}
