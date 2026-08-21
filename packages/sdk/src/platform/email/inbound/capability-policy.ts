/**
 * capability-policy.ts, what `surfaces.email.inbound.onInsufficientCapability`
 * actually selects, and where it cannot select anything.
 *
 * ── The problem this file exists to remove ────────────────────────────────
 *
 * The schema promises that `notice-only` "keeps announcing that mail arrived
 * using envelope fields alone (sender, subject, delivery evidence), stating
 * plainly in every notice that bodies are unavailable, and it can never satisfy
 * a verification expectation while degraded."
 *
 * That promise is true of exactly ONE condition, and it was written as though
 * it were true of all of them. Walk the `insufficient` reasons and there is
 * nothing to announce on any of the others:
 *
 *   - `credentials-missing` / `credentials-rejected`, we cannot sign in. There
 *     is no envelope, because there is no session.
 *   - `mailbox-unreadable`, signed in, and the mailbox will not open. Same.
 *   - `uidvalidity-missing` / `mailbox-position-unknown`, the mailbox opened
 *     and we cannot keep a position in it. Announcing from here would mean
 *     announcing the whole mailbox as new, repeatedly.
 *   - `fetch-refused`, minted from a FAILED envelope fetch (`capability.ts`).
 *     When it fires there are no envelopes; that is what failed.
 *   - `fetch-unreadable`, the server answers and we cannot parse the answer.
 *     There is nothing legible to put in a notice.
 *   - `local-store-unwritable`, our own disk. Announcing would mean announcing
 *     the same message on every pass, because nothing can record that we did.
 *   - `watcher-stopped-unexpectedly`, by definition we do not know what
 *     happened.
 *
 * The one that leaves envelopes readable is `gmail-metadata-only`: Google's
 * `gmail.metadata` scope authorizes `users.history.list` and
 * `users.messages.get?format=metadata` and excludes the body, "View your email
 * message metadata such as labels and headers, but not the email body", its own
 * description, verbatim. Headers are available; bodies are not. That is the
 * only place `notice-only` describes something the daemon can do.
 *
 * ── So it degrades, and it says so ────────────────────────────────────────
 *
 * `notice-only` on any other reason resolves to `refuse-and-notify`, which is
 * what the daemon was going to do regardless, since there is nothing to
 * announce, and `resolveInboundCapabilityPolicy` returns the SENTENCE that
 * says the setting did not apply. That sentence rides on the capability
 * verdict's `detail`, which the supervisor's status and the terminal notice
 * both already render, so the owner reads it on the surface they were going to
 * look at anyway.
 *
 * A silent degrade is the failure mode here, not a wrong one. An owner who set
 * `notice-only` and then heard nothing would conclude no mail arrived. What
 * actually happened is that their mailbox stopped for a reason their setting
 * could not soften, and the setting is not the thing to go and check.
 *
 * ── Why this is a function and not a branch at the call site ──────────────
 *
 * Because the rule is "which reasons leave envelopes readable", and that is a
 * property of the reason vocabulary, not of any one source. Written inline it
 * would be an `if` in the Gmail source and a different `if` somewhere else the
 * day a second body-less grant exists, and the two would disagree about a
 * security property. `NOTICE_ONLY_CAPABLE_REASONS` is the whole answer, in one
 * place, keyed off the union so the compiler is involved.
 */

import type { InboundCapabilityReason } from './capability-types.js';

/**
 * The `surfaces.email.inbound.onInsufficientCapability` vocabulary.
 *
 * Structurally identical to `InboundEmailCapabilityPolicy` in
 * `config/schema-types-surfaces.ts` and deliberately not imported from it: the
 * config layer owns what the owner may SET, this layer owns what the daemon
 * DOES, and a runtime module reaching into the settings schema for its own
 * vocabulary is the dependency that makes the schema unbuildable without the
 * mail stack. `test/inbound-email-config-schema.test.ts` asserts the two are
 * the same set, so they cannot drift unnoticed.
 */
export type InboundCapabilityPolicy = 'refuse-and-notify' | 'notice-only';

/**
 * The shipped value of `surfaces.email.inbound.onInsufficientCapability`.
 *
 * Restated here so a caller resolving an unset or unreadable key falls back to
 * the value the schema ships rather than to whichever of the two a reader
 * happened to write first. The config schema remains the authority; this is a
 * mirror with a test holding it to the original.
 */
export const INBOUND_CAPABILITY_POLICY_DEFAULT: InboundCapabilityPolicy = 'refuse-and-notify';

/**
 * Every reason on which `notice-only` describes something that can actually
 * happen, that is, every reason that leaves envelope fields readable.
 *
 * A `Set` of the union's own members, so adding a reason to
 * `InboundCapabilityReason` does not silently join this list, and a member
 * removed from the union stops compiling here.
 *
 * Two entries, and they are the SAME condition seen under each policy: a
 * `gmail.metadata` grant refusing (`gmail-metadata-only`) and the same grant
 * announcing (`gmail-metadata-notice-only`). Both are here because the question
 * this set answers is "does this condition leave envelope fields readable",
 * which is a fact about the grant and not about the policy, asking it of the
 * running state has to give the same answer as asking it of the stopped one, or
 * a source that had already switched to announcing would be told its own
 * setting does not apply. Every other reason in the union is absent, and that
 * is the finding rather than an oversight: see the file header for the walk.
 */
export const NOTICE_ONLY_CAPABLE_REASONS: ReadonlySet<InboundCapabilityReason> = new Set<
  InboundCapabilityReason
>(['gmail-metadata-only', 'gmail-metadata-notice-only']);

/** What the daemon will actually do, and what the owner is told about it. */
export interface ResolvedInboundCapabilityPolicy {
  /** What `surfaces.email.inbound.onInsufficientCapability` says. */
  readonly configured: InboundCapabilityPolicy;
  /** What this reason permits. Never weaker than `refuse-and-notify`. */
  readonly effective: InboundCapabilityPolicy;
  /**
   * True when the two differ, the owner asked for `notice-only` on a condition
   * that cannot honour it.
   */
  readonly degraded: boolean;
  /**
   * One sentence, appended to the capability verdict's `detail`, saying which
   * policy is in force and, when they differ, why the configured one is not.
   *
   * Never empty. A caller that appends it unconditionally always adds a true
   * statement, so there is no branch at the call site deciding whether the
   * owner gets told, which is the branch that gets written the wrong way round.
   */
  readonly statusSentence: string;
}

/**
 * Resolve the configured policy against one capability reason.
 *
 * Total over the reason union: every reason not in
 * `NOTICE_ONLY_CAPABLE_REASONS` resolves `notice-only` to `refuse-and-notify`,
 * so a reason added later degrades safely by default and has to be opted IN to
 * the weaker behaviour deliberately.
 */
export function resolveInboundCapabilityPolicy(
  configured: InboundCapabilityPolicy,
  reason: InboundCapabilityReason,
): ResolvedInboundCapabilityPolicy {
  if (configured === 'refuse-and-notify') {
    return {
      configured,
      effective: 'refuse-and-notify',
      degraded: false,
      statusSentence:
        'surfaces.email.inbound.onInsufficientCapability is "refuse-and-notify", so inbound mail '
        + 'for this account stops until the condition above is fixed.',
    };
  }

  if (NOTICE_ONLY_CAPABLE_REASONS.has(reason)) {
    return {
      configured,
      effective: 'notice-only',
      degraded: false,
      statusSentence:
        'surfaces.email.inbound.onInsufficientCapability is "notice-only", so arriving mail is '
        + 'still announced from its sender, subject and delivery address. Nothing is read beyond '
        + 'those fields, and no verification expectation can be satisfied while this lasts, a '
        + 'signup or order confirmation waiting on a link in a message body will wait until it '
        + 'expires.',
    };
  }

  return {
    configured,
    effective: 'refuse-and-notify',
    degraded: true,
    statusSentence:
      'surfaces.email.inbound.onInsufficientCapability is set to "notice-only", and it does not '
      + `apply to this condition: "${reason}" leaves no envelope fields to announce, so there is `
      + 'nothing this setting could show you. Inbound mail for this account has stopped, exactly '
      + 'as "refuse-and-notify" would. "notice-only" applies only to a Google grant that '
      + 'authorizes message headers and excludes message bodies (the gmail.metadata scope), which '
      + 'is the one condition where mail can be seen arriving without being readable.',
  };
}
