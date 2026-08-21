/**
 * Renders the written fallback runbook from the step plan.
 *
 * The automation and the runbook read the same records in
 * `google-setup-plan.ts`, so they cannot drift. `docs/google-setup-runbook.md`
 * is the checked-in output of `renderGoogleSetupRunbook()`, and a test
 * regenerates it and fails if the committed copy is stale. When automation
 * gives up, its error message points at the anchor for the step that stopped.
 */

import {
  GOOGLE_SETUP_STEPS,
  OAUTH_SCOPES,
  REQUIRED_SERVICES,
  stepsForPath,
} from './setup-plan.js';
import type { GoogleSetupPath, GoogleSetupStepSpec, GoogleStepActor } from './types.js';

/** Path to the generated runbook, relative to the repository root. */
export const RUNBOOK_RELATIVE_PATH = 'docs/google-setup-runbook.md';

function actorLabel(actor: GoogleStepActor): string {
  if (actor === 'automated') return 'Automated. The flow does this for you.';
  if (actor === 'human-assisted') return 'Needs one action from you. The flow opens the page and tells you what to click.';
  return 'Manual. This one cannot be automated at all.';
}

function renderStep(step: GoogleSetupStepSpec, index: number): string {
  const lines: string[] = [];
  lines.push(`### ${index}. ${step.title}`);
  lines.push('');
  lines.push(`<a id="${step.id}"></a>`);
  lines.push('');
  lines.push(`**Who does it:** ${actorLabel(step.actor)}`);
  lines.push('');
  lines.push(`**Why:** ${step.purpose}`);
  lines.push('');
  if (step.url !== undefined) {
    lines.push(`**Page:** ${step.url}`);
    lines.push('');
  }
  lines.push('**By hand:**');
  lines.push('');
  step.manualSteps.forEach((instruction, position) => {
    lines.push(`${position + 1}. ${instruction}`);
  });
  lines.push('');
  return lines.join('\n');
}

function renderPathSection(path: GoogleSetupPath, heading: string, preamble: readonly string[]): string {
  const steps = stepsForPath(path);
  const lines: string[] = [];
  lines.push(`## ${heading}`);
  lines.push('');
  preamble.forEach((paragraph) => {
    lines.push(paragraph);
    lines.push('');
  });
  steps.forEach((step, index) => {
    lines.push(renderStep(step, index + 1));
  });
  return lines.join('\n');
}

const APP_PASSWORD_PREAMBLE: readonly string[] = [
  'This is the fast lane and the default. There is no Google Cloud project, no API to enable, no OAuth client, no consent screen, and no token that expires. One app password, and Gmail works.',
  '**What you get:** Gmail read and send over IMAP/SMTP, and read-only calendar.',
  "**What you don't get:** writing calendar events, and Gmail push notifications. Those need the OAuth path below.",
  'A note on calendar, because it is the one place this path is narrower than it looks. Google refuses HTTP Basic authentication on its CalDAV endpoint. Its own documentation says "Attempting to connect over HTTP or using Basic Authentication results in an HTTP `401 Unauthorized` status code" ([CalDAV guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)). So an app password cannot reach Google Calendar over CalDAV, no matter how it is configured. The private iCal address is used instead. It works without any credential setup, and it is read-only.',
  `**Time:** about three minutes, most of it waiting for a 2-Step Verification prompt.`,
];

const OAUTH_PREAMBLE: readonly string[] = [
  'Take this path when you need to write calendar events, use Gmail push/watch channels, or run richer queries than IMAP allows.',
  'It is longer because Google exposes no API for two of the steps: the consent screen and creating an OAuth client. Those are done in the browser. Everything else is scripted through `gcloud`.',
  '**Read this before you start.** An OAuth app left in **Testing** publishing status is issued refresh tokens that expire after **seven days**. Google documents this plainly: "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of \'Testing\' is issued a refresh token expiring in 7 days" ([OAuth 2.0 guide](https://developers.google.com/identity/protocols/oauth2)). The exemption for apps requesting only `openid`/`email`/`profile` does not apply here. Gmail and Calendar scopes are sensitive or restricted.',
  'Skipping the publishing-status step means this integration silently stops working one week later, and the failure looks like an unrelated auth error. Step 6 is the one that matters most.',
  `**Scopes requested:** ${OAUTH_SCOPES.map((scope) => `\`${scope}\``).join(', ')}`,
  `**APIs enabled:** ${REQUIRED_SERVICES.map((service) => `\`${service}\``).join(', ')}`,
  '**Time:** about fifteen minutes.',
];

/** Render the complete runbook markdown. */
export function renderGoogleSetupRunbook(): string {
  const humanSteps = GOOGLE_SETUP_STEPS.filter((step) => step.actor === 'human-assisted');
  const lines: string[] = [];

  lines.push('# Connecting Gmail and Google Calendar');
  lines.push('');
  lines.push(
    '> This file is generated from the SDK\'s Google setup plan (`packages/sdk/src/platform/google/setup-plan.ts`). Do not edit it by hand. Edit the plan and regenerate, or the test that compares the two will fail. It exists so that when the automation cannot finish a step, there is a written route through the same work that cannot have drifted out of date.',
  );
  lines.push('');
  lines.push('## Just ask');
  lines.push('');
  lines.push('Say "connect my Google account". That is the whole of it.');
  lines.push('');
  lines.push(
    'The agent works out the shortest route on its own: a credential already stored, an OAuth client that only needs your consent, or the gcloud CLI for the project and APIs. It asks you for at most one thing: opening a consent link and approving it. It reports what it is doing at every step, hands you only the pages that must genuinely be yours, and finishes by reading your mail and your calendar to prove the connection works.',
  );
  lines.push('');
  lines.push(
    'If a step needs a value only you can see, such as the client id and secret Google shows once when you create the client, an app password, or a private calendar address, paste it into the conversation and the agent stores it. You are never asked to type a command to hand a value over.',
  );
  lines.push('');
  lines.push('<details><summary>Self-service equivalents</summary>');
  lines.push('');
  lines.push(
    'These exist for anyone who prefers driving it themselves. They are not the intended route, and nothing in the flow will tell you to run one.',
  );
  lines.push('');
  lines.push('```');
  lines.push('/google connect     # work out the route and connect');
  lines.push('/google status      # what is connected, proven by use');
  lines.push('/google reauthorize # a fresh consent covering every scope');
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push('## Which path do I want?');
  lines.push('');
  lines.push('| | App password | OAuth |');
  lines.push('| --- | --- | --- |');
  lines.push('| Read Gmail | yes | yes |');
  lines.push('| Send Gmail | yes | yes |');
  lines.push('| Read calendar | yes (read-only) | yes |');
  lines.push('| Write calendar | no | yes |');
  lines.push('| Gmail push notifications | no | yes |');
  lines.push('| Google Cloud project needed | no | yes |');
  lines.push('| Credential expires | no | only if you skip the publishing step |');
  lines.push('| Setup time | ~3 min | ~15 min |');
  lines.push('');
  lines.push('Start with the app password path. Add OAuth later if you hit its limits. They coexist, and setting up one does not undo the other.');
  lines.push('');
  lines.push('## What needs you, and what does not');
  lines.push('');
  lines.push(
    `Everything is automated except ${humanSteps.length} points where Google requires a real human action. They are unavoidable: Google blocks automated browsers at sign-in, and consent cannot be granted programmatically by design.`,
  );
  lines.push('');
  humanSteps.forEach((step) => {
    lines.push(`- **${step.title}** ([details](${`#${step.id}`})): ${step.path === 'app-password' ? 'app password path' : 'OAuth path'}`);
  });
  lines.push('');
  lines.push(
    'Google rejects automated browsers with "this browser or app may not be secure". The flow uses a persistent browser profile, so you sign in **once, by hand**, and every later run reuses that session. When a sign-in is needed the flow says so and stops. It never loops or pretends.',
  );
  lines.push('');
  lines.push(renderPathSection('app-password', 'Path A: app password (start here)', APP_PASSWORD_PREAMBLE));
  lines.push(renderPathSection('oauth', 'Path B: OAuth (full Gmail and Calendar APIs)', OAUTH_PREAMBLE));
  lines.push('## If something goes wrong');
  lines.push('');
  lines.push('**Re-run the command.** It detects what already exists and skips it, so re-running after fixing something never duplicates work or creates a second project, client, or app password.');
  lines.push('');
  lines.push('**"This browser or app may not be secure"**: Google is refusing the automated browser at sign-in. Sign in by hand in the window that opened, then re-run. The session persists after that.');
  lines.push('');
  lines.push('**IMAP fails with `AUTHENTICATIONFAILED`**: the app password is wrong or was revoked. Google never re-displays an existing app password, so delete the `goodvibes-agent` entry at https://myaccount.google.com/apppasswords and re-run to create a fresh one.');
  lines.push('');
  lines.push('**Everything worked, then broke about a week later**: this is the Testing-publishing-status trap. Check https://console.cloud.google.com/auth/audience: if publishing status reads "Testing", click PUBLISH APP, then re-authorize. The old token cannot be salvaged.');
  lines.push('');
  lines.push('**"Google hasn\'t verified this app"**: expected. The app is self-certified, not Google-reviewed. Click "Advanced", then "Go to goodvibes agent (unsafe)". Google allows up to 100 users on an unverified app, which is ample for a personal install.');
  lines.push('');
  lines.push('## Where credentials live');
  lines.push('');
  lines.push(
    'Every secret is written to the encrypted secret store and referenced from config by name only: the app password, the OAuth client secret, the refresh token, and the private calendar address. No secret is written to config files, logs, transcripts, or `goodvibes-agent status` output. The private calendar address is treated as a credential because anyone holding it can read the calendar.',
  );
  lines.push('');

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
