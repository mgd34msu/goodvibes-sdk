/**
 * Proving a Google connection works, by using it.
 *
 * The defect this exists to fix is subtle and it cost the owner most of an
 * evening: the flow reported success after storing a refresh token, and the
 * first CALENDAR call afterwards failed with "insufficient authentication
 * scopes". Storing a credential is not evidence that the credential does the
 * job — a token can be perfectly valid and still carry the wrong scopes, name
 * a different account, or belong to a project whose APIs are switched off.
 * Every one of those looks identical to success at the moment of storage.
 *
 * So a connection run does not finish by saying "stored". It finishes by
 * reading the mailbox and reading the calendar, and reporting what it read.
 * "Connected and proven" or a specific reason, never "try it and see".
 *
 * Both calls are reads. `users.getProfile` returns the address and message
 * counts and touches nothing; `events.list` reads the primary calendar. No
 * message is sent, nothing is marked read, no event is created. This is safe
 * to run on every connection and on demand.
 */

import type { GoogleApiClient } from './api-client.js';

/** One capability, proven or not, with the reason when not. */
export interface GoogleProofResult {
  readonly ok: boolean;
  /** What was actually read. Safe to display. */
  readonly detail: string;
  /** Populated only on failure. */
  readonly problem?: string;
  readonly fix?: string;
}

export interface GoogleConnectionProof {
  /** True only when BOTH mail and calendar answered. */
  readonly ok: boolean;
  readonly mail: GoogleProofResult;
  readonly calendar: GoogleProofResult;
  /** The address Google says this credential belongs to, when it answered. */
  readonly account: string | null;
  /** One line for the end of a connection run. */
  readonly summary: string;
}

/**
 * A scope refusal has a distinctive shape and a distinctive remedy, so it is
 * separated from every other failure. Google answers a missing scope with 403
 * and the phrase "insufficient authentication scopes" — the exact failure the
 * owner hit on calendar after a Gmail-only consent.
 */
function isScopeRefusal(status: number | null, problem: string): boolean {
  return status === 403 && /insufficient (authentication )?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(problem);
}

/** A disabled API is the other confusable 403, and its remedy is different. */
function isServiceDisabled(problem: string): boolean {
  return /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(problem);
}

function classify(
  capability: 'mail' | 'calendar',
  status: number | null,
  problem: string,
): GoogleProofResult {
  if (isScopeRefusal(status, problem)) {
    return {
      ok: false,
      detail: `${capability === 'mail' ? 'Mail' : 'Calendar'} refused the credential.`,
      problem:
        `The stored credential does not carry the ${capability === 'mail' ? 'Gmail' : 'Calendar'} scope. `
        + 'A grant carries exactly the scopes that were approved, so this consent was approved without it.',
      fix: 'Run /google reauthorize — it asks for mail and calendar together in one consent, so this cannot happen again.',
    };
  }
  if (isServiceDisabled(problem)) {
    return {
      ok: false,
      detail: `${capability === 'mail' ? 'Mail' : 'Calendar'} is not enabled on the Cloud project.`,
      problem: `The credential is valid but the ${capability === 'mail' ? 'Gmail' : 'Calendar'} API is switched off on the project this client belongs to. ${problem}`,
      fix: 'Run /google connect — it enables both APIs through gcloud when gcloud is signed in.',
    };
  }
  return {
    ok: false,
    detail: `${capability === 'mail' ? 'Mail' : 'Calendar'} could not be read.`,
    problem,
    fix: 'Run /google status to see the stored credential, then /google reauthorize if it needs a fresh consent.',
  };
}

/**
 * Read mail and calendar with the live credential.
 *
 * Both are attempted even when the first fails, because "mail works and
 * calendar does not" is a materially different report from "nothing works",
 * and stopping at the first failure would hide which one it is.
 */
export async function proveGoogleConnection(client: GoogleApiClient): Promise<GoogleConnectionProof> {
  const [profile, events] = await Promise.all([client.getProfile(), client.listEvents({ maxResults: 1 })]);

  const mail: GoogleProofResult = profile.ok
    ? {
      ok: true,
      detail: `Read the mailbox for ${profile.value.emailAddress} (${profile.value.messagesTotal} messages).`,
    }
    : classify('mail', profile.status, profile.problem);

  const calendar: GoogleProofResult = events.ok
    ? {
      ok: true,
      detail:
        events.value.length === 0
          ? 'Read the primary calendar — it has no upcoming events.'
          : `Read the primary calendar (next event: ${events.value[0]?.summary ?? 'untitled'}).`,
    }
    : classify('calendar', events.status, events.problem);

  const account = profile.ok ? profile.value.emailAddress : null;
  const ok = mail.ok && calendar.ok;

  return {
    ok,
    mail,
    calendar,
    account,
    summary: ok
      ? `Connected and proven${account === null ? '' : ` as ${account}`} — mail and calendar both answered.`
      : mail.ok
        ? 'Mail works; calendar does not. The credential is connected but incomplete.'
        : calendar.ok
          ? 'Calendar works; mail does not. The credential is connected but incomplete.'
          : 'The credential is stored but neither mail nor calendar would answer.',
  };
}

/** The proof as lines for a transcript. */
export function describeGoogleConnectionProof(proof: GoogleConnectionProof): readonly string[] {
  const lines: string[] = [proof.summary];
  for (const result of [proof.mail, proof.calendar]) {
    lines.push(`  ${result.ok ? 'ok' : 'no'}: ${result.detail}`);
    if (result.problem !== undefined) lines.push(`      ${result.problem}`);
    if (result.fix !== undefined) lines.push(`      Do this: ${result.fix}`);
  }
  return lines;
}
