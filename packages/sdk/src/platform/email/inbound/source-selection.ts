/**
 * source-selection.ts, which source reads the mailbox
 * (docs/inbound-email.md §3.4d, "Selection is automatic").
 *
 * The whole point of this file is that adopting Google is the ENTIRE setup for
 * the common case. Google adopted and the configured mail account is a Gmail
 * account means the Gmail source; anything else means IMAP; and
 * `surfaces.email.inbound.source` can force either, because every flag in this
 * design ships as a real configurable feature rather than a switch.
 *
 * Two properties, both deliberate.
 *
 * **It reads nothing.** Every input arrives as a value. There is no config
 * read, no credential lookup and no network call in this module, so the
 * decision is a pure function of three facts and a test can state each of them
 * directly. The alternative, a selector that goes and finds out for itself,
 * is a selector that cannot be exercised without a machine that has Google
 * adopted on it.
 *
 * **Forcing `gmail` where Gmail cannot work is REFUSED, not quietly served
 * over IMAP.** That is already the shipped contract: the description on
 * `surfaces.email.inbound.source` says so in the words the owner reads in his
 * settings, "Forcing 'gmail' without adopted Google credentials, or on an
 * account that is not a Gmail account, is refused rather than quietly served
 * over IMAP." Silently substituting the other source would leave him with a
 * setting that says one thing while the daemon does another, which is the same
 * silent-degradation failure §3.4b refuses everywhere else. So the refusal is
 * a result shape the caller must handle, carrying the step that fixes it.
 */

import type { InboundEmailSource } from '../../config/schema-types-surfaces.js';

/** The two sources, as a running watcher is built from one. */
export type InboundMailSourceKind = 'imap' | 'gmail';

/**
 * The facts the decision is made from.
 *
 * `configured` is the declared config type rather than a restated
 * `'auto' | 'gmail' | 'imap'`: a hand-copied union is a second declaration
 * that can drift from the schema, and a fourth value added there would then
 * silently fall through a `switch` here instead of failing to compile.
 */
export interface InboundSourceSelectionInput {
  /** `surfaces.email.inbound.source`, already read by the caller. */
  readonly configured: InboundEmailSource;
  /**
   * Whether a Gmail source is available to read with.
   *
   * NOT "whether Google credentials are adopted", which is what this was
   * called and what its messages claimed. It used to be set from
   * `options.gmail !== undefined`, the presence of an injected Gmail source
   * BUILDER, and no composition passed one, so it was permanently false and
   * an owner who had connected Google was told "no Google credentials have
   * been adopted", which sent him to look for a credential that was already
   * there.
   *
   * It is now the answer from a composition that actually opened the
   * credential and asked Google for the mailbox
   * (`resolveGmailInboundReader`), and when it is false the reason arrives
   * alongside it in `gmailUnavailable` rather than being guessed at here.
   */
  readonly googleAdopted: boolean;
  /**
   * Why no Gmail source is available, in the composition's own words.
   *
   * A VALUE, so this module still reads nothing and decides nothing it was not
   * told, the property the header states. Present only when `googleAdopted`
   * is false, and carried into the message the owner reads, because the three
   * conditions behind that boolean need three different actions: no account
   * connected, a grant Google refused, or a network that could not be reached.
   * Absent, the messages fall back to naming every possibility, which is what
   * a selector handed one bare boolean can honestly say.
   */
  readonly gmailUnavailable?: string | undefined;
  /**
   * Whether the configured mail account is a Gmail account.
   *
   * Separate from `googleAdopted` because the two genuinely come apart: an
   * owner can have adopted Google for calendar and drive while the mailbox the
   * inbound watcher is pointed at lives on his own domain, and Gmail's history
   * API cannot read that mailbox.
   */
  readonly mailAccountIsGmail: boolean;
}

/** Why the selection came out the way it did. Named, so nothing parses prose. */
export type InboundSourceBasis =
  /** The owner named this source explicitly. */
  | 'forced'
  /** `auto`: Google is adopted and the mail account is a Gmail account. */
  | 'google-adopted'
  /** `auto`: no Google credentials, so there is no Gmail API to use. */
  | 'google-not-adopted'
  /** `auto`: Google is adopted, but this mailbox is not a Gmail one. */
  | 'not-a-gmail-account';

/** Why a forced selection could not be honoured. */
export type InboundSourceRefusal =
  | 'gmail-forced-without-google'
  | 'gmail-forced-on-non-gmail-account';

export interface InboundSourceSelected {
  readonly kind: 'selected';
  readonly source: InboundMailSourceKind;
  readonly basis: InboundSourceBasis;
  /** One sentence for the owner, naming what was chosen and why. */
  readonly detail: string;
}

export interface InboundSourceRefused {
  readonly kind: 'refused';
  readonly reason: InboundSourceRefusal;
  readonly detail: string;
  /** The one remedial step. */
  readonly fix: string;
}

/**
 * A selection, or a refusal to make one.
 *
 * A union rather than a source plus an `ok` flag: a caller that forgot to
 * check the flag would start a Gmail source against a mailbox Gmail cannot
 * read, and there is no source on the refused arm to start.
 */
export type InboundSourceSelection = InboundSourceSelected | InboundSourceRefused;

/**
 * The composition's reason, or every possibility when it did not give one.
 *
 * The fallback is the honest reading of a bare `googleAdopted: false`: a
 * selector told one boolean cannot know which of the three conditions produced
 * it, and asserting the first, which is what "no Google credentials have been
 * adopted on this machine" did, sent an owner who HAD connected Google looking
 * for a credential that was already there.
 */
function reasonOrEveryPossibility(input: InboundSourceSelectionInput): string {
  const reason = input.gmailUnavailable?.trim() ?? '';
  if (reason.length > 0) return reason;
  return 'Either no Google credentials have been adopted on this machine, or the Gmail reader '
    + 'is not wired into this build; the daemon reported no reason, so both are named rather '
    + 'than asserting the one that was not checked.';
}

/**
 * The remedial step for a forced-`gmail` refusal.
 *
 * Two shapes, because the owner needs different things in the two cases. When
 * the composition named a reason it also named what fixes it, `gmailUnavailable`
 * carries the reader's own `fix`, so repeating a guess here would be a second
 * instruction competing with the accurate one. When it named nothing, the step
 * that resolves the commonest cause has to be stated, and it is: connect Google.
 *
 * Falling back to IMAP is offered in BOTH, and only ever as an explicit change
 * the owner makes. This function never authorizes the daemon to make it.
 */
function refusalFix(input: InboundSourceSelectionInput): string {
  const meanwhile = 'Set surfaces.email.inbound.source to "imap" (or back to "auto") to read the '
    + 'mailbox over IMAP meanwhile.';
  if ((input.gmailUnavailable?.trim() ?? '').length > 0) return meanwhile;
  return `Connect Google if you have not. If Google is already connected, this is the daemon `
    + `missing its Gmail reader rather than anything you can change. ${meanwhile}`;
}

/**
 * Pick the source for one mailbox.
 *
 * Pure. Every input is supplied; nothing here reads configuration, opens a
 * credential store or asks a network.
 */
export function selectInboundMailSource(
  input: InboundSourceSelectionInput,
): InboundSourceSelection {
  if (input.configured === 'imap') {
    // Always honourable: IMAP needs no Google anything. Forcing it on a Gmail
    // account is a legitimate choice, IDLE is true push and the Gmail source
    // is polled, so it is honoured without comment.
    return {
      kind: 'selected',
      source: 'imap',
      basis: 'forced',
      detail: 'Inbound mail is read over IMAP because surfaces.email.inbound.source is set to "imap". '
        + 'IMAP holds an IDLE connection, which is push: new mail is noticed within about a second.',
    };
  }

  if (input.configured === 'gmail') {
    if (!input.googleAdopted) {
      return {
        kind: 'refused',
        reason: 'gmail-forced-without-google',
        detail: 'surfaces.email.inbound.source is set to "gmail", and this daemon has no Gmail source '
          + `to read with. ${reasonOrEveryPossibility(input)}`,
        fix: refusalFix(input),
      };
    }
    if (!input.mailAccountIsGmail) {
      return {
        kind: 'refused',
        reason: 'gmail-forced-on-non-gmail-account',
        detail: 'surfaces.email.inbound.source is set to "gmail", and the configured mail account is not '
          + 'a Gmail account. The Gmail API reads the mailbox belonging to the adopted Google '
          + 'credentials and cannot read a mailbox on another provider.',
        fix: 'Point the inbound watcher at the Gmail account those credentials belong to, or set '
          + 'surfaces.email.inbound.source to "imap" (or back to "auto") to read this mailbox over IMAP.',
      };
    }
    return {
      kind: 'selected',
      source: 'gmail',
      basis: 'forced',
      detail: 'Inbound mail is read through the Gmail API because surfaces.email.inbound.source is set '
        + 'to "gmail". This is polling, not push: mail can go unnoticed for up to one poll interval.',
    };
  }

  // 'auto', the default, and the case that needs no configuration at all.
  if (!input.googleAdopted) {
    return {
      kind: 'selected',
      source: 'imap',
      basis: 'google-not-adopted',
      detail: 'Inbound mail is read over IMAP because no Gmail source is available. '
        + `${reasonOrEveryPossibility(input)} IMAP holds an IDLE connection, which is push: new `
        + 'mail is noticed within about a second, so this is the better of the two paths either way.',
    };
  }
  if (!input.mailAccountIsGmail) {
    return {
      kind: 'selected',
      source: 'imap',
      basis: 'not-a-gmail-account',
      detail: 'Inbound mail is read over IMAP because the configured mail account is not a Gmail '
        + 'account, so the Gmail API cannot read it even though Google is connected.',
    };
  }
  return {
    kind: 'selected',
    source: 'gmail',
    basis: 'google-adopted',
    detail: 'Inbound mail is read through the Gmail API because Google is already connected and the '
      + 'configured mail account is a Gmail account, so no IMAP host, username or app password has '
      + 'to be found. This is polling, not push: mail can go unnoticed for up to one poll interval.',
  };
}
