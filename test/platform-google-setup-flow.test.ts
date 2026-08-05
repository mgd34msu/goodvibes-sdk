/**
 * The flow executor, the step plan, and the generated runbook.
 *
 * The runbook drift test is the important one: the written fallback exists so
 * a user has a route when automation fails, and a stale runbook is worse than
 * none because it sends them somewhere that no longer matches reality.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FORBIDDEN_OAUTH_SCOPES,
  GOOGLE_SETUP_STEPS,
  OAUTH_SCOPES,
  REQUIRED_SERVICES,
  stepSpec,
  stepsForPath,
} from '../packages/sdk/src/platform/google/setup-plan.ts';
import {
  renderGoogleSetupReport,
  runGoogleSetupFlow,
  type GoogleStepRunner,
  type GoogleStepRunnerResult,
} from '../packages/sdk/src/platform/google/setup-flow.ts';
import {
  renderGoogleSetupRunbook,
  RUNBOOK_RELATIVE_PATH,
} from '../packages/sdk/src/platform/google/setup-runbook.ts';
import type {
  GoogleProgressPort,
  GoogleSetupStepSpec,
  GoogleStepId,
  GoogleStepResult,
} from '../packages/sdk/src/platform/google/types.ts';

function recordingProgress(): {
  readonly port: GoogleProgressPort;
  readonly started: string[];
  readonly finished: string[];
  readonly humanPrompts: string[];
} {
  const started: string[] = [];
  const finished: string[] = [];
  const humanPrompts: string[] = [];
  return {
    started,
    finished,
    humanPrompts,
    port: {
      stepStarted: (spec: GoogleSetupStepSpec): void => {
        started.push(spec.id);
      },
      stepFinished: (spec: GoogleSetupStepSpec, result: GoogleStepResult): void => {
        finished.push(`${spec.id}:${result.outcome}`);
      },
      humanActionNeeded: (spec: GoogleSetupStepSpec, instruction: string): void => {
        humanPrompts.push(`${spec.id}:${instruction}`);
      },
      note: (): void => {},
    },
  };
}

function runnersFor(
  path: 'app-password' | 'oauth',
  overrides: Partial<Record<GoogleStepId, GoogleStepRunnerResult>> = {},
): ReadonlyMap<GoogleStepId, GoogleStepRunner> {
  const map = new Map<GoogleStepId, GoogleStepRunner>();
  for (const spec of stepsForPath(path)) {
    const override = overrides[spec.id];
    map.set(spec.id, async () => override ?? { outcome: 'done', detail: `${spec.id} completed` });
  }
  return map;
}

describe('the Google setup step plan', () => {
  test('every step id is unique across both paths', () => {
    const ids = GOOGLE_SETUP_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every declared dependency refers to a step in the same path', () => {
    for (const step of GOOGLE_SETUP_STEPS) {
      for (const required of step.requires ?? []) {
        const dependency = stepSpec(required);
        expect(dependency.path).toBe(step.path);
      }
    }
  });

  test('dependencies always appear before the step that requires them', () => {
    for (const path of ['app-password', 'oauth'] as const) {
      const order = stepsForPath(path).map((step) => step.id);
      for (const step of stepsForPath(path)) {
        for (const required of step.requires ?? []) {
          expect(order.indexOf(required)).toBeLessThan(order.indexOf(step.id));
        }
      }
    }
  });

  test('every step carries manual instructions, so the runbook is never empty for it', () => {
    for (const step of GOOGLE_SETUP_STEPS) {
      expect(step.manualSteps.length).toBeGreaterThan(0);
      for (const instruction of step.manualSteps) {
        expect(instruction.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('stepSpec throws on an unknown id rather than returning undefined', () => {
    expect(() => stepSpec('not-a-real-step' as GoogleStepId)).toThrow();
  });

  test('one consent covers every Google feature this platform has', () => {
    // The defect: a token was minted with Gmail scopes only and the first
    // calendar call afterwards failed with "insufficient authentication
    // scopes". A grant carries exactly what was approved, so anything missing
    // here becomes a feature that reports connected and then refuses.
    //
    // Every entry below has a live caller. gmail.readonly serves
    // api-client.listMessages and the history delta; gmail.send serves
    // api-client.sendMessage; calendar.events serves listEvents/createEvent.
    expect([...OAUTH_SCOPES].sort()).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });

  test('no scope granting mailbox deletion or full control is ever requested', () => {
    // The guard that survived the scope widening, and it is about WIDTH rather
    // than Google's fee tiers. gmail.modify can delete messages and
    // https://mail.google.com/ is full mailbox control; nothing in this
    // product does either, so requesting one would enlarge what a leaked
    // credential reaches in exchange for nothing.
    for (const forbidden of FORBIDDEN_OAUTH_SCOPES) {
      expect(OAUTH_SCOPES).not.toContain(forbidden);
    }
  });

  test('the Gmail API is enabled, because the scopes are useless without it', () => {
    // A scope whose API is switched off fails with a service-disabled error
    // rather than an auth error, which is a genuinely confusing thing to
    // debug. Requesting Gmail scopes while enabling only Calendar was exactly
    // that trap.
    expect(REQUIRED_SERVICES).toContain('gmail.googleapis.com');
    expect(REQUIRED_SERVICES).toContain('calendar-json.googleapis.com');
  });
});

describe('the existing-client path', () => {
  // The headline defect: a machine that already held a client id and secret
  // was walked through the new-project Branding workflow anyway.

  test('goes straight to consent, never to project, branding or audience setup', () => {
    const ids = stepsForPath('existing-client').map((step) => step.id);
    expect(ids).toEqual(['oauth-authorize', 'oauth-verify']);
    for (const forbidden of ['gcloud-project', 'oauth-branding', 'oauth-audience-production', 'oauth-client']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  test('the authorize step does not sit waiting on a step this path omits', () => {
    // oauth-authorize requires oauth-client on the full OAuth path. Left
    // unpruned, the executor would see an unmet dependency and skip the only
    // step that matters, so "go straight to consent" would quietly do nothing.
    const authorize = stepsForPath('existing-client').find((step) => step.id === 'oauth-authorize');
    expect(authorize?.requires ?? []).toEqual([]);
  });

  test('the full OAuth path still keeps its real dependency chain', () => {
    const authorize = stepsForPath('oauth').find((step) => step.id === 'oauth-authorize');
    expect(authorize?.requires).toContain('oauth-client');
  });
});

describe('the guided new-client instructions', () => {
  // Verified against Google's live documentation on 2026-08-05: the Gmail API
  // quickstart's "Authorize credentials for a desktop application" and
  // support.google.com/cloud/answer/15549257 (Manage OAuth Clients).

  const clientStep = stepSpec('oauth-client');
  const text = clientStep.manualSteps.join('\n');

  test('names every concrete console step by its current label', () => {
    expect(text).toContain('Create client');
    expect(text).toContain('Desktop app');
    expect(text).toContain('"Name" field');
    expect(text).toContain('Client ID');
    expect(text).toContain('Client secret');
  });

  test('warns that the client secret is shown exactly once', () => {
    // support.google.com/cloud/answer/15549257: "you will only be able to view
    // and download the full client secret once, at the time of its creation."
    // Miss that moment and the client has to be recreated.
    expect(text).toMatch(/last four characters|only at this moment|only ever shown once/i);
  });

  test('sends the person to a command that takes the two values by hand', () => {
    expect(text).toContain('/google client <client-id> <client-secret>');
  });

  test('never tells anyone to download or hand over a credential file', () => {
    // Google's current console pages document no "download the JSON" action
    // for OAuth client IDs — the Manage OAuth Clients page has no such
    // control, and the quickstart names neither the button nor where it
    // appears. Those steps could not be verified against the live console, so
    // the guided path does not send anyone looking for a file. Handing over a
    // path still works; it is user-directed, never talked into.
    for (const step of stepsForPath('oauth')) {
      const instructions = step.manualSteps.join('\n').toLowerCase();
      expect(instructions).not.toContain('download the json');
      expect(instructions).not.toContain('credentials.json');
      expect(instructions).not.toContain('.json file');
    }
  });
});

describe('the generated runbook', () => {
  test('the checked-in doc matches what the plan generates, so it cannot drift', () => {
    const repoRoot = join(import.meta.dir, '..');
    const committed = readFileSync(join(repoRoot, RUNBOOK_RELATIVE_PATH), 'utf8');
    expect(committed).toBe(renderGoogleSetupRunbook());
  });

  test('every step has an anchor the automation can point an error message at', () => {
    const runbook = renderGoogleSetupRunbook();
    for (const step of GOOGLE_SETUP_STEPS) {
      expect(runbook).toContain(`<a id="${step.id}"></a>`);
    }
  });

  test('it states plainly that a Testing app issues credentials expiring in seven days', () => {
    const runbook = renderGoogleSetupRunbook();
    expect(runbook).toContain('seven days');
    expect(runbook.toLowerCase()).toContain('testing');
  });

  test('it explains why the app-password path cannot reach calendar over CalDAV', () => {
    // Google's CalDAV endpoint refuses Basic authentication outright, so an
    // app password cannot be used there. If that explanation ever falls out
    // of the doc, users will keep trying the thing that cannot work.
    expect(renderGoogleSetupRunbook()).toContain('Basic Authentication');
  });
});

describe('running a setup path', () => {
  test('it runs every step of the path in order and reports success', async () => {
    const progress = recordingProgress();
    const report = await runGoogleSetupFlow('app-password', {
      progress: progress.port,
      runners: runnersFor('app-password'),
    });

    expect(report.ok).toBe(true);
    expect(report.waitingOn).toBeNull();
    expect(progress.started).toEqual(stepsForPath('app-password').map((step) => step.id));
  });

  test('it stops at a step that needs the human and marks the rest not-attempted', async () => {
    const progress = recordingProgress();
    const report = await runGoogleSetupFlow('app-password', {
      progress: progress.port,
      runners: runnersFor('app-password', {
        'two-step-verification': {
          outcome: 'needs-human',
          detail: 'Two-step verification is off.',
          problem: 'Google only offers app passwords when 2-Step Verification is on.',
          fix: 'Turn on 2-Step Verification, then re-run.',
        },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.waitingOn).toBe('two-step-verification');
    expect(progress.humanPrompts).toHaveLength(1);
    const later = report.steps.find((step) => step.id === 'app-password');
    expect(later?.outcome).toBe('skipped');
  });

  test('a step that needs the human carries a runbook anchor to fall back to', async () => {
    const report = await runGoogleSetupFlow('app-password', {
      progress: recordingProgress().port,
      runners: runnersFor('app-password', {
        'google-signed-in': {
          outcome: 'needs-human',
          detail: 'Sign-in needed.',
          problem: 'Google is showing its sign-in page.',
          fix: 'Sign in by hand in the open window, then re-run.',
        },
      }),
    });

    const step = report.steps.find((entry) => entry.id === 'google-signed-in');
    expect(step?.runbookAnchor).toBe('#google-signed-in');
  });

  test('already-done steps count as satisfied so dependent steps still run', async () => {
    const report = await runGoogleSetupFlow('app-password', {
      progress: recordingProgress().port,
      runners: runnersFor('app-password', {
        'app-password': { outcome: 'already-done', detail: 'An app password is already stored.' },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.steps.find((step) => step.id === 'gmail-config')?.outcome).toBe('done');
  });

  test('re-running when everything is already done reports that there was nothing to do', async () => {
    const overrides: Partial<Record<GoogleStepId, GoogleStepRunnerResult>> = {};
    for (const step of stepsForPath('app-password')) {
      overrides[step.id] = { outcome: 'already-done', detail: 'already configured' };
    }
    const report = await runGoogleSetupFlow('app-password', {
      progress: recordingProgress().port,
      runners: runnersFor('app-password', overrides),
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toContain('Nothing to do');
  });

  test('a runner that throws is reported as a failure rather than escaping', async () => {
    const runners = new Map<GoogleStepId, GoogleStepRunner>(runnersFor('app-password'));
    runners.set('app-password', async () => {
      throw new Error('the page layout changed');
    });

    const report = await runGoogleSetupFlow('app-password', {
      progress: recordingProgress().port,
      runners,
    });

    expect(report.ok).toBe(false);
    const failed = report.steps.find((step) => step.id === 'app-password');
    expect(failed?.outcome).toBe('failed');
    expect(failed?.problem).toContain('the page layout changed');
    // The fallback route has to be something an installed binary can act on.
    // A packaged install has no checkout, so a repo path is a dead end.
    expect(failed?.fix).toContain('/google runbook');
    expect(failed?.fix).not.toContain('docs/');
  });

  test('warnings from a step survive into the report', async () => {
    const report = await runGoogleSetupFlow('oauth', {
      progress: recordingProgress().port,
      runners: runnersFor('oauth', {
        'oauth-verify': {
          outcome: 'done',
          detail: 'Authorized.',
          warnings: ['The app is still in Testing, so this credential expires in seven days.'],
        },
      }),
    });

    expect(report.warnings.join(' ')).toContain('seven days');
  });

  test('a missing runner is a wiring bug and throws rather than silently skipping', async () => {
    const runners = new Map<GoogleStepId, GoogleStepRunner>(runnersFor('app-password'));
    runners.delete('browser-ready');
    await expect(
      runGoogleSetupFlow('app-password', { progress: recordingProgress().port, runners }),
    ).rejects.toThrow('No runner registered');
  });
});

describe('rendering a report', () => {
  test('a failed run points the reader at the written instructions', async () => {
    const report = await runGoogleSetupFlow('app-password', {
      progress: recordingProgress().port,
      runners: runnersFor('app-password', {
        'gmail-verify': {
          outcome: 'failed',
          detail: 'Could not connect.',
          problem: 'IMAP rejected the credential.',
          fix: 'Create a new app password and re-run.',
        },
      }),
    });

    const rendered = renderGoogleSetupReport(report);
    expect(rendered).toContain('IMAP rejected the credential.');
    expect(rendered).toContain('Do this: Create a new app password');
    expect(rendered).toContain('Written instructions for every step: /google runbook');
    expect(rendered).not.toContain('docs/google-setup-runbook.md');
  });
});
