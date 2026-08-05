/**
 * Saying why a Google grant stopped working, instead of trying it again.
 *
 * The defect this exists to fix: a refresh returned `invalid_grant` and the
 * agent retried the identical request six times. Every attempt was guaranteed
 * to fail — `invalid_grant` is Google's way of saying the token is not coming
 * back, ever — and none of the six produced a single word about why. The
 * person watching learned nothing across six round trips.
 *
 * `invalid_grant` has a small number of real causes and they need different
 * things from the person, so guessing between them silently is the worst
 * option. This module names the likely one in plain words and says what to do,
 * and `token-manager.ts` latches on the result so the same dead refresh is
 * never sent a second time.
 *
 * The most common cause by far is the account trap: the consent screen was
 * approved while signed in as a personal Google account, so the refresh token
 * belongs to a different identity than the one the product is configured for.
 * Nothing about that is visible in Google's error text, which is why this
 * takes the intended account and the signed-in account as inputs and compares
 * them itself.
 */

/** Why a grant is no longer usable. */
export type GoogleGrantFailureCause =
  /** The token was minted under a different Google account than the configured one. */
  | 'account-mismatch'
  /** The person (or Google) revoked the grant, or it aged out. */
  | 'revoked'
  /** The refresh token does not belong to the client id being used with it. */
  | 'client-mismatch'
  /** The app is still in Testing, so the token expired seven days after issue. */
  | 'testing-expiry'
  /** None of the signatures matched. The candidates are still stated. */
  | 'unknown';

export interface GoogleGrantDiagnosis {
  readonly cause: GoogleGrantFailureCause;
  /** Plain words. Never a token, never a raw Google error alone. */
  readonly problem: string;
  /** What to do, naming a command that exists. */
  readonly fix: string;
  /** True for every cause here — a dead grant always needs a person. */
  readonly needsReauthorization: true;
}

export interface GrantDiagnosisInput {
  /** Google's own error text, used only as a signature. May be empty. */
  readonly googleError: string;
  /** The account this product is configured for, when known. */
  readonly intendedAccount: string | null;
  /** The account the machine is actually signed in as (gcloud), when known. */
  readonly signedInAccount: string | null;
  /** Last known publishing status, which decides whether a 7-day fuse applies. */
  readonly publishingStatus: 'testing' | 'in-production' | 'unknown';
  /** Where the credential came from, which changes the remedy wording. */
  readonly credentialOrigin: 'secret-store' | 'gmail-mcp' | null;
}

/** The command that re-runs consent with the full scope set. Must exist. */
/**
 * What the platform OFFERS to do, rather than a command to type.
 *
 * A dead grant needs a fresh consent, and producing one is the platform's job.
 * Naming a command here would hand the person a chore in the same breath as
 * telling them their credential is broken.
 */
const REAUTHORIZE_OFFER = 'Say the word and I will start a fresh consent';

function normalize(account: string | null): string | null {
  const trimmed = account?.trim().toLowerCase();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/**
 * Work out the likely cause and say it.
 *
 * Ordered most-specific first: a signature Google actually gave us beats an
 * inference, and an account mismatch we can see for ourselves beats a generic
 * "it expired". Every branch returns a fix naming a real command.
 */
export function diagnoseInvalidGrant(input: GrantDiagnosisInput): GoogleGrantDiagnosis {
  const error = input.googleError.toLowerCase();
  const intended = normalize(input.intendedAccount);
  const signedIn = normalize(input.signedInAccount);

  // The account trap, and it is checked first because it is both the most
  // common cause and the only one invisible in Google's error text.
  if (intended !== null && signedIn !== null && intended !== signedIn) {
    return {
      cause: 'account-mismatch',
      problem:
        `This credential was granted by ${signedIn}, but this product is set up for ${intended}. `
        + 'A refresh token belongs to the account that approved it, so one account\'s token can never speak for another\'s mailbox or calendar.',
      fix:
        `${REAUTHORIZE_OFFER}. On the Google consent screen, sign in as ${intended} — `
        + `not ${signedIn}. If the account picker is already showing ${signedIn}, choose "Use another account".`,
      needsReauthorization: true,
    };
  }

  // Google's own wording for a revoked or aged-out grant.
  if (/expired or revoked|token has been revoked|account has been deleted|user rescinded/i.test(error)) {
    return {
      cause: 'revoked',
      problem:
        'Google reports this refresh token as expired or revoked. That happens when the account\'s access to the app was removed at '
        + 'https://myaccount.google.com/permissions, when the password was changed, or when a token issued under a Testing app aged out.',
      fix: `${REAUTHORIZE_OFFER} for you to approve. Nothing is deleted until you say so.`,
      needsReauthorization: true,
    };
  }

  // A token used against the wrong client is a distinct, fixable mistake.
  if (/client|unauthorized_client|mismatch/i.test(error)) {
    return {
      cause: 'client-mismatch',
      problem:
        'The stored refresh token does not belong to the stored OAuth client id. A token is tied to the exact client that requested it, '
        + 'so this happens when one half of a credential was replaced without the other.',
      fix: `${REAUTHORIZE_OFFER}, minting a token against the client that is actually stored.`,
      needsReauthorization: true,
    };
  }

  // A Testing app issues tokens on a seven-day fuse, so a grant that simply
  // stopped working a week after setup has an obvious explanation.
  if (input.publishingStatus === 'testing') {
    return {
      cause: 'testing-expiry',
      problem:
        'The OAuth app is still in "Testing" publishing status, and Google expires refresh tokens from a Testing app seven days after they are issued. '
        + 'This credential has almost certainly hit that fuse.',
      fix:
        'Publish the app at https://console.cloud.google.com/auth/audience — set publishing status to "In production", which is self-certified and needs no review — '
        + `then ${REAUTHORIZE_OFFER.toLowerCase()}.`,
      needsReauthorization: true,
    };
  }

  const adoptedNote =
    input.credentialOrigin === 'gmail-mcp'
      ? ' This credential was taken up from another tool\'s files, so it may also have been rotated by that tool.'
      : '';

  return {
    cause: 'unknown',
    problem:
      'Google rejected this refresh token and did not say which reason applies. The three that produce this are: the token was approved by a different '
      + 'Google account than the one configured here, the grant was revoked at https://myaccount.google.com/permissions, or the token does not match the '
      + `stored client id.${adoptedNote}`,
    fix:
      `${REAUTHORIZE_OFFER} — watch which account it offers, because approving as the wrong account is the most common cause of this.`,
    needsReauthorization: true,
  };
}

/** The diagnosis as lines for a transcript. Problem first, then the remedy. */
export function describeGrantDiagnosis(diagnosis: GoogleGrantDiagnosis): readonly string[] {
  return [diagnosis.problem, `Do this: ${diagnosis.fix}`];
}
