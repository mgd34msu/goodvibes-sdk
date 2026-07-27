/**
 * Two layers of coverage for the Google browser-driven page flows.
 *
 * Layer 1 drives every flow through a hand-written fake `GoogleBrowserPort`
 * with scripted snapshots/text, covering every branch the flows define.
 *
 * Layer 2 drives the adapter (`browser-port.ts`) against a FAKE
 * `BrowserEngine`, proving the snapshot-to-element mapping, the
 * untrusted-content envelope unwrapping and the implicit session adoption.
 * It used to launch a real Chromium and was gated on one being provisioned, so
 * on a machine without one it silently ran nothing; a test that reports
 * success by not running is worse than no test, so it is deterministic now and
 * runs everywhere.
 */

import { describe, expect, test } from 'bun:test';
import type { BrowserEngine } from '../packages/sdk/src/platform/browser/browser-engine.ts';
import {
  describeElements,
  findElement,
  looksLikeGoogleSignIn,
  requireElement,
} from '../packages/sdk/src/platform/google/browser-elements.ts';
import { createGoogleBrowserPort } from '../packages/sdk/src/platform/google/browser-port.ts';
import type { GoogleElementLookup } from '../packages/sdk/src/platform/google/browser-elements.ts';
import { createAppPassword } from '../packages/sdk/src/platform/google/app-password-flow.ts';
import { captureIcsAddress } from '../packages/sdk/src/platform/google/calendar-ics-flow.ts';
import {
  createDesktopOAuthClient,
  publishApp,
  readPublishingStatus,
} from '../packages/sdk/src/platform/google/console-flow.ts';
import type { GoogleBrowserElement, GoogleBrowserPort } from '../packages/sdk/src/platform/google/types.ts';

// ---------------------------------------------------------------------------
// Layer 1 test double
// ---------------------------------------------------------------------------

interface FakePage {
  readonly url: string;
  readonly elements: readonly GoogleBrowserElement[];
  readonly text: string;
}

type FakeTransitions = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * A `GoogleBrowserPort` whose pages are named states. `click(ref)` moves to
 * whatever state `transitions[currentState][ref]` names, if anything;
 * everything else just reads back whatever the current state describes.
 */
class ScriptedGoogleBrowserPort implements GoogleBrowserPort {
  private stateId: string;
  readonly navigated: string[] = [];
  readonly clicked: string[] = [];
  readonly typed: Array<{ readonly ref: string; readonly text: string }> = [];

  constructor(
    private readonly pages: Readonly<Record<string, FakePage>>,
    initialStateId: string,
    private readonly transitions: FakeTransitions = {},
  ) {
    this.stateId = initialStateId;
  }

  private page(): FakePage {
    const page = this.pages[this.stateId];
    if (!page) {
      throw new Error(`test fake: no page registered for state "${this.stateId}"`);
    }
    return page;
  }

  async navigate(url: string): Promise<{ readonly url: string; readonly title: string }> {
    this.navigated.push(url);
    return { url: this.page().url, title: 'fake-title' };
  }

  async currentUrl(): Promise<string> {
    return this.page().url;
  }

  async snapshot(): Promise<readonly GoogleBrowserElement[]> {
    return this.page().elements;
  }

  async click(ref: string): Promise<void> {
    this.clicked.push(ref);
    const next = this.transitions[this.stateId]?.[ref];
    if (next) this.stateId = next;
  }

  async type(ref: string, text: string): Promise<void> {
    this.typed.push({ ref, text });
  }

  async readText(): Promise<string> {
    return this.page().text;
  }
}

function singleStatePort(url: string, elements: readonly GoogleBrowserElement[], text: string = ''): ScriptedGoogleBrowserPort {
  return new ScriptedGoogleBrowserPort({ only: { url, elements, text } }, 'only');
}

function el(ref: string, role: string, name: string, extra: { readonly tag?: string; readonly value?: string } = {}): GoogleBrowserElement {
  return { ref, role, name, tag: extra.tag ?? 'div', value: extra.value };
}

const NORMAL_APP_PASSWORD_URL = 'https://myaccount.google.com/apppasswords';
const NORMAL_AUDIENCE_URL = 'https://console.cloud.google.com/auth/audience';
const NORMAL_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';
const NORMAL_CALENDAR_URL = 'https://calendar.google.com/calendar/u/0/r/settings';
const SIGN_IN_URL = 'https://accounts.google.com/signin/v2/identifier';

// ---------------------------------------------------------------------------
// Element matcher — findElement / requireElement / describeElements
// ---------------------------------------------------------------------------

describe('findElement', () => {
  const elements: readonly GoogleBrowserElement[] = [
    el('e1', 'textbox', '  App   Name  '),
    el('e2', 'button', 'CREATE'),
    el('e3', 'link', 'Integrate calendar', { tag: 'a' }),
  ];

  test('matches names case-insensitively', () => {
    expect(findElement(elements, { nameIncludes: 'create' })?.ref).toBe('e2');
  });

  test('matches names with internal and surrounding whitespace normalized away', () => {
    expect(findElement(elements, { nameIncludes: 'app name' })?.ref).toBe('e1');
  });

  test('filters by role when given', () => {
    expect(findElement(elements, { role: 'link' })?.ref).toBe('e3');
    expect(findElement(elements, { role: 'button', nameIncludes: 'app name' })).toBeNull();
  });

  test('filters by tag when given', () => {
    expect(findElement(elements, { tag: 'a' })?.ref).toBe('e3');
    expect(findElement(elements, { tag: 'select' })).toBeNull();
  });

  test('filters by a name pattern when given', () => {
    expect(findElement(elements, { namePattern: /integrate/i })?.ref).toBe('e3');
  });

  test('returns null when nothing matches', () => {
    expect(findElement(elements, { nameIncludes: 'does not exist anywhere' })).toBeNull();
  });
});

describe('requireElement', () => {
  test('returns the element wrapped in a found:true result on a match', () => {
    const elements = [el('e1', 'button', 'Create')];
    const lookup = requireElement(elements, { role: 'button', nameIncludes: 'create' });
    expect(lookup.found).toBe(true);
    if (lookup.found) expect(lookup.element.ref).toBe('e1');
  });

  test('a miss names exactly what was looked for and what the page showed instead', () => {
    const elements = [el('e1', 'button', 'Cancel'), el('e2', 'link', 'Learn more')];
    const lookup = requireElement(elements, { role: 'button', nameIncludes: 'create' });
    expect(lookup.found).toBe(false);
    if (!lookup.found) {
      expect(lookup.message).toContain('role "button"');
      expect(lookup.message).toContain('a name containing "create"');
      expect(lookup.message).toContain('button "Cancel"');
      expect(lookup.message).toContain('link "Learn more"');
      expect(lookup.candidateCount).toBe(2);
    }
  });

  test('a miss on an empty page says so plainly', () => {
    const lookup = requireElement([], { role: 'button', nameIncludes: 'create' });
    expect(lookup.found).toBe(false);
    if (!lookup.found) {
      expect(lookup.message).toContain('no interactive elements were found');
    }
  });
});

describe('describeElements', () => {
  test('truncates long lists and reports how many were left out', () => {
    const many: GoogleBrowserElement[] = Array.from({ length: 15 }, (_unused, index) => el(`e${String(index)}`, 'button', `Button ${String(index)}`));
    const described = describeElements(many);
    expect(described).toContain('and 5 more');
  });
});

describe('looksLikeGoogleSignIn', () => {
  test('a sign-in url is detected', () => {
    expect(looksLikeGoogleSignIn(SIGN_IN_URL, [])).toBe(true);
  });

  test('a real password textbox is detected even on the original url', () => {
    const elements = [el('e1', 'textbox', 'Enter your password')];
    expect(looksLikeGoogleSignIn(NORMAL_APP_PASSWORD_URL, elements)).toBe(true);
  });

  test('a heading or button that merely contains the word "password" is not mistaken for a sign-in page', () => {
    const elements = [el('e1', 'heading', 'App passwords', { tag: 'h1' }), el('e2', 'button', 'Create app password')];
    expect(looksLikeGoogleSignIn(NORMAL_APP_PASSWORD_URL, elements)).toBe(false);
  });

  test('an ordinary page is not flagged', () => {
    const elements = [el('e1', 'button', 'Create')];
    expect(looksLikeGoogleSignIn(NORMAL_APP_PASSWORD_URL, elements)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAppPassword
// ---------------------------------------------------------------------------

describe('createAppPassword (fake port)', () => {
  test('creates the password on the happy path and reads it back normalized', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        form: {
          url: NORMAL_APP_PASSWORD_URL,
          elements: [el('name-field', 'textbox', 'App name'), el('create-btn', 'button', 'Create')],
          text: 'App passwords\nCreate and manage your app passwords.',
        },
        result: {
          url: NORMAL_APP_PASSWORD_URL,
          elements: [],
          text: 'Your app password for goodvibes-agent is:\nwxyz abcd efgh ijkl\nDone',
        },
      },
      'form',
      { form: { 'create-btn': 'result' } },
    );

    const result = await createAppPassword(port, { label: 'goodvibes-agent' });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.password).toBe('wxyzabcdefghijkl');
      expect(result.detail).toContain('goodvibes-agent');
      expect(result.detail).not.toContain(result.password);
    }
    expect(port.typed).toEqual([{ ref: 'name-field', text: 'goodvibes-agent' }]);
  });

  test('reports needs-sign-in when Google redirects to a sign-in page', async () => {
    const port = singleStatePort(SIGN_IN_URL, []);
    const result = await createAppPassword(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') {
      expect(result.reason).toBe('sign-in-required');
      expect(result.fix).toContain('Sign in');
    }
  });

  test('reports needs-sign-in when the url looks normal but a password field is shown', async () => {
    const port = singleStatePort(NORMAL_APP_PASSWORD_URL, [el('pw', 'textbox', 'Enter your password')]);
    const result = await createAppPassword(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('sign-in-required');
  });

  test('reports needs-two-step when the page text says 2-Step Verification is required', async () => {
    const port = singleStatePort(
      NORMAL_APP_PASSWORD_URL,
      [],
      '2-Step Verification is off. Turn on 2-Step Verification to create app passwords.',
    );
    const result = await createAppPassword(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') {
      expect(result.reason).toBe('two-step-required');
      expect(result.fix).toContain('signinoptions/twosv');
    }
  });

  test('reports needs-two-step when the create form is simply absent with no explanatory text', async () => {
    const port = singleStatePort(NORMAL_APP_PASSWORD_URL, [], '');
    const result = await createAppPassword(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('two-step-required');
  });

  test('reports already-exists when a password with the same label is already listed, and never asks to create a duplicate', async () => {
    const port = singleStatePort(NORMAL_APP_PASSWORD_URL, [
      el('name-field', 'textbox', 'App name'),
      el('create-btn', 'button', 'Create'),
      el('delete-btn', 'button', 'Delete goodvibes-agent app password'),
    ]);
    const result = await createAppPassword(port, { label: 'goodvibes-agent' });
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') {
      expect(result.reason).toBe('label-already-exists');
      expect(result.fix).toContain('Reuse');
      expect(result.fix).toContain('delete');
    }
    expect(port.clicked).toEqual([]);
  });

  test('reports create-form-not-found with a specific diagnostic when only part of the form is missing', async () => {
    const port = singleStatePort(NORMAL_APP_PASSWORD_URL, [el('name-field', 'textbox', 'App name')]);
    const result = await createAppPassword(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('create-form-not-found');
      expect(result.problem).toContain('role "button"');
      expect(result.problem).toContain('textbox "App name"');
    }
  });

  test('reports result-dialog-not-found when the create click never produces a readable password', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        form: {
          url: NORMAL_APP_PASSWORD_URL,
          elements: [el('name-field', 'textbox', 'App name'), el('create-btn', 'button', 'Create')],
          text: '',
        },
        stuck: { url: NORMAL_APP_PASSWORD_URL, elements: [], text: 'Nothing happened.' },
      },
      'form',
      { form: { 'create-btn': 'stuck' } },
    );
    const result = await createAppPassword(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('result-dialog-not-found');
  });

  test('accepts an injected pageUrl override instead of navigating to the real Google page', async () => {
    const localUrl = 'http://127.0.0.1:9/apppasswords';
    const port = singleStatePort(localUrl, [], '2-Step Verification is off.');
    await createAppPassword(port, { pageUrl: localUrl });
    expect(port.navigated).toEqual([localUrl]);
  });
});

// ---------------------------------------------------------------------------
// captureIcsAddress
// ---------------------------------------------------------------------------

const VALID_ICS_URL = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abcdef1234567890/basic.ics';

describe('captureIcsAddress (fake port)', () => {
  test('captures the address on the happy path using the default (first) calendar', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        settings: {
          url: NORMAL_CALENDAR_URL,
          elements: [el('cal-1', 'link', 'My Calendar'), el('cal-2', 'link', 'Other Calendar')],
          text: '',
        },
        'integrate-panel': {
          url: NORMAL_CALENDAR_URL,
          elements: [el('integrate-link', 'link', 'Integrate calendar')],
          text: '',
        },
        'ics-shown': {
          url: NORMAL_CALENDAR_URL,
          elements: [],
          text: `Secret address in iCal format\n${VALID_ICS_URL}`,
        },
      },
      'settings',
      { settings: { 'cal-1': 'integrate-panel' }, 'integrate-panel': { 'integrate-link': 'ics-shown' } },
    );

    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.icsUrl).toBe(VALID_ICS_URL);
      expect(result.detail).not.toContain(result.icsUrl);
    }
  });

  test('finds a named calendar when calendarName is given', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        settings: {
          url: NORMAL_CALENDAR_URL,
          elements: [el('cal-1', 'link', 'General'), el('cal-2', 'link', 'Work Calendar')],
          text: '',
        },
        'integrate-panel': { url: NORMAL_CALENDAR_URL, elements: [el('integrate-link', 'link', 'Integrate calendar')], text: '' },
        'ics-shown': { url: NORMAL_CALENDAR_URL, elements: [], text: VALID_ICS_URL },
      },
      'settings',
      { settings: { 'cal-2': 'integrate-panel' }, 'integrate-panel': { 'integrate-link': 'ics-shown' } },
    );
    const result = await captureIcsAddress(port, { calendarName: 'Work' });
    expect(result.kind).toBe('ok');
  });

  test('reports needs-sign-in when Google redirects to a sign-in page', async () => {
    const port = singleStatePort(SIGN_IN_URL, []);
    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('sign-in-required');
  });

  test('reports calendar-not-found when no calendar entries are in the settings panel', async () => {
    const port = singleStatePort(NORMAL_CALENDAR_URL, [el('general', 'link', 'General'), el('add', 'link', 'Add calendar')]);
    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('calendar-not-found');
  });

  test('reports calendar-not-found naming the requested calendar when calendarName does not match anything', async () => {
    const port = singleStatePort(NORMAL_CALENDAR_URL, [el('cal-1', 'link', 'My Calendar')]);
    const result = await captureIcsAddress(port, { calendarName: 'Nonexistent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('calendar-not-found');
      expect(result.problem).toContain('Nonexistent');
    }
  });

  test('reports integrate-panel-not-found when "Integrate calendar" is missing after opening the calendar', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        settings: { url: NORMAL_CALENDAR_URL, elements: [el('cal-1', 'link', 'My Calendar')], text: '' },
        opened: { url: NORMAL_CALENDAR_URL, elements: [el('other', 'link', 'Notifications')], text: '' },
      },
      'settings',
      { settings: { 'cal-1': 'opened' } },
    );
    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('integrate-panel-not-found');
  });

  test('reports ics-address-not-found when the integrate panel has no address at all', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        settings: { url: NORMAL_CALENDAR_URL, elements: [el('cal-1', 'link', 'My Calendar')], text: '' },
        panel: { url: NORMAL_CALENDAR_URL, elements: [el('integrate-link', 'link', 'Integrate calendar')], text: '' },
        shown: { url: NORMAL_CALENDAR_URL, elements: [], text: 'Nothing useful here.' },
      },
      'settings',
      { settings: { 'cal-1': 'panel' }, panel: { 'integrate-link': 'shown' } },
    );
    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('ics-address-not-found');
  });

  test('reports ics-address-malformed when a calendar.google.com/ical value is present but not the private basic.ics shape', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        settings: { url: NORMAL_CALENDAR_URL, elements: [el('cal-1', 'link', 'My Calendar')], text: '' },
        panel: { url: NORMAL_CALENDAR_URL, elements: [el('integrate-link', 'link', 'Integrate calendar')], text: '' },
        shown: {
          url: NORMAL_CALENDAR_URL,
          elements: [],
          text: 'https://calendar.google.com/calendar/ical/me%40example.com/public/basic.ics',
        },
      },
      'settings',
      { settings: { 'cal-1': 'panel' }, panel: { 'integrate-link': 'shown' } },
    );
    const result = await captureIcsAddress(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('ics-address-malformed');
      // The candidate value itself must never appear in the message, even malformed.
      expect(result.problem).not.toContain('me%40example.com');
    }
  });
});

// ---------------------------------------------------------------------------
// readPublishingStatus / publishApp
// ---------------------------------------------------------------------------

describe('readPublishingStatus (fake port)', () => {
  test('reads "testing"', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Publishing status: Testing');
    const result = await readPublishingStatus(port);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.status).toBe('testing');
  });

  test('reads "in-production"', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Publishing status: In production');
    const result = await readPublishingStatus(port);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.status).toBe('in-production');
  });

  test('reports needs-sign-in', async () => {
    const port = singleStatePort(SIGN_IN_URL, []);
    const result = await readPublishingStatus(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('sign-in-required');
  });

  test('reports project-not-selected', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Select a project to continue.');
    const result = await readPublishingStatus(port);
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('project-not-selected');
  });

  test('reports status-not-found when neither status word appears', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Nothing relevant here.');
    const result = await readPublishingStatus(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('status-not-found');
  });
});

describe('publishApp (fake port)', () => {
  test('does nothing and reports ok when already in production', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Publishing status: In production');
    const result = await publishApp(port);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.status).toBe('in-production');
    expect(port.clicked).toEqual([]);
  });

  test('clicks PUBLISH APP, confirms, and reports ok only once the re-read verifies "in production"', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        testing: {
          url: NORMAL_AUDIENCE_URL,
          elements: [el('publish-btn', 'button', 'PUBLISH APP')],
          text: 'Publishing status: Testing',
        },
        confirming: {
          url: NORMAL_AUDIENCE_URL,
          elements: [el('confirm-btn', 'button', 'Confirm')],
          text: 'Publishing status: Testing',
        },
        published: {
          url: NORMAL_AUDIENCE_URL,
          elements: [],
          text: 'Publishing status: In production',
        },
      },
      'testing',
      { testing: { 'publish-btn': 'confirming' }, confirming: { 'confirm-btn': 'published' } },
    );

    const result = await publishApp(port);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.status).toBe('in-production');
    expect(port.clicked).toEqual(['publish-btn', 'confirm-btn']);
  });

  test('the branch that matters most: reports failure when the status still reads testing after clicking and confirming', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        testing: {
          url: NORMAL_AUDIENCE_URL,
          elements: [el('publish-btn', 'button', 'PUBLISH APP')],
          text: 'Publishing status: Testing',
        },
        confirming: {
          url: NORMAL_AUDIENCE_URL,
          elements: [el('confirm-btn', 'button', 'Confirm')],
          text: 'Publishing status: Testing',
        },
        'still-testing': {
          url: NORMAL_AUDIENCE_URL,
          elements: [],
          text: 'Publishing status: Testing',
        },
      },
      'testing',
      { testing: { 'publish-btn': 'confirming' }, confirming: { 'confirm-btn': 'still-testing' } },
    );

    const result = await publishApp(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toBe('publish-did-not-take');
      // Must state plainly what is at stake, not just that it failed.
      expect(result.problem).toContain('seven days');
    }
  });

  test('reports publish-button-not-found when PUBLISH APP is missing', async () => {
    const port = singleStatePort(NORMAL_AUDIENCE_URL, [], 'Publishing status: Testing');
    const result = await publishApp(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('publish-button-not-found');
  });

  test('reports confirm-dialog-not-found when clicking PUBLISH APP shows no confirm button', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        testing: { url: NORMAL_AUDIENCE_URL, elements: [el('publish-btn', 'button', 'PUBLISH APP')], text: 'Publishing status: Testing' },
        'no-dialog': { url: NORMAL_AUDIENCE_URL, elements: [], text: 'Publishing status: Testing' },
      },
      'testing',
      { testing: { 'publish-btn': 'no-dialog' } },
    );
    const result = await publishApp(port);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('confirm-dialog-not-found');
  });
});

// ---------------------------------------------------------------------------
// createDesktopOAuthClient
// ---------------------------------------------------------------------------

describe('createDesktopOAuthClient (fake port)', () => {
  function happyPathPort(): ScriptedGoogleBrowserPort {
    return new ScriptedGoogleBrowserPort(
      {
        'clients-list': {
          url: NORMAL_CLIENTS_URL,
          elements: [el('create-client-btn', 'button', 'CREATE CLIENT')],
          text: '',
        },
        'type-select': {
          url: NORMAL_CLIENTS_URL,
          elements: [el('type-combobox', 'combobox', 'Application type')],
          text: '',
        },
        'type-options': {
          url: NORMAL_CLIENTS_URL,
          elements: [el('desktop-option', 'option', 'Desktop app')],
          text: '',
        },
        'name-field': {
          url: NORMAL_CLIENTS_URL,
          elements: [el('name-field-el', 'textbox', 'Name'), el('create-btn', 'button', 'Create')],
          text: '',
        },
        created: {
          url: NORMAL_CLIENTS_URL,
          elements: [],
          text: 'Client ID\nabc123-xyz.apps.googleusercontent.com\nClient secret\nGOCSPX-supersecretvalue123',
        },
      },
      'clients-list',
      {
        'clients-list': { 'create-client-btn': 'type-select' },
        'type-select': { 'type-combobox': 'type-options' },
        'type-options': { 'desktop-option': 'name-field' },
        'name-field': { 'create-btn': 'created' },
      },
    );
  }

  test('creates a client on the happy path and reads back id and secret', async () => {
    const port = happyPathPort();
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.clientId).toBe('abc123-xyz.apps.googleusercontent.com');
      expect(result.clientSecret).toBe('GOCSPX-supersecretvalue123');
      expect(result.detail).not.toContain(result.clientSecret);
    }
    expect(port.typed).toEqual([{ ref: 'name-field-el', text: 'goodvibes agent' }]);
  });

  test('reports needs-sign-in', async () => {
    const port = singleStatePort(SIGN_IN_URL, []);
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('sign-in-required');
  });

  test('reports client-already-exists instead of creating a duplicate', async () => {
    const port = singleStatePort(NORMAL_CLIENTS_URL, [
      el('existing', 'generic', 'goodvibes agent'),
      el('create-client-btn', 'button', 'CREATE CLIENT'),
    ]);
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('needs-human');
    if (result.kind === 'needs-human') expect(result.reason).toBe('client-already-exists');
    expect(port.clicked).toEqual([]);
  });

  test('reports create-client-button-not-found', async () => {
    const port = singleStatePort(NORMAL_CLIENTS_URL, []);
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('create-client-button-not-found');
  });

  test('reports application-type-not-found when the type dropdown is missing', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        'clients-list': { url: NORMAL_CLIENTS_URL, elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: '' },
        'no-dropdown': { url: NORMAL_CLIENTS_URL, elements: [], text: '' },
      },
      'clients-list',
      { 'clients-list': { 'create-client-btn': 'no-dropdown' } },
    );
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('application-type-not-found');
  });

  test('reports application-type-not-found when the "Desktop app" option is missing from the dropdown', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        'clients-list': { url: NORMAL_CLIENTS_URL, elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: '' },
        'type-select': { url: NORMAL_CLIENTS_URL, elements: [el('type-combobox', 'combobox', 'Application type')], text: '' },
        'no-desktop-option': { url: NORMAL_CLIENTS_URL, elements: [el('web-option', 'option', 'Web application')], text: '' },
      },
      'clients-list',
      {
        'clients-list': { 'create-client-btn': 'type-select' },
        'type-select': { 'type-combobox': 'no-desktop-option' },
      },
    );
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('application-type-not-found');
  });

  test('reports name-field-not-found', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        'clients-list': { url: NORMAL_CLIENTS_URL, elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: '' },
        'type-select': { url: NORMAL_CLIENTS_URL, elements: [el('type-combobox', 'combobox', 'Application type')], text: '' },
        'type-options': { url: NORMAL_CLIENTS_URL, elements: [el('desktop-option', 'option', 'Desktop app')], text: '' },
        'no-name-field': { url: NORMAL_CLIENTS_URL, elements: [], text: '' },
      },
      'clients-list',
      {
        'clients-list': { 'create-client-btn': 'type-select' },
        'type-select': { 'type-combobox': 'type-options' },
        'type-options': { 'desktop-option': 'no-name-field' },
      },
    );
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('name-field-not-found');
  });

  test('reports create-button-not-found', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        'clients-list': { url: NORMAL_CLIENTS_URL, elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: '' },
        'type-select': { url: NORMAL_CLIENTS_URL, elements: [el('type-combobox', 'combobox', 'Application type')], text: '' },
        'type-options': { url: NORMAL_CLIENTS_URL, elements: [el('desktop-option', 'option', 'Desktop app')], text: '' },
        'name-field': { url: NORMAL_CLIENTS_URL, elements: [el('name-field-el', 'textbox', 'Name')], text: '' },
      },
      'clients-list',
      {
        'clients-list': { 'create-client-btn': 'type-select' },
        'type-select': { 'type-combobox': 'type-options' },
        'type-options': { 'desktop-option': 'name-field' },
      },
    );
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('create-button-not-found');
  });

  test('reports credentials-not-readable when Create produces no readable id/secret pair', async () => {
    const port = new ScriptedGoogleBrowserPort(
      {
        'clients-list': { url: NORMAL_CLIENTS_URL, elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: '' },
        'type-select': { url: NORMAL_CLIENTS_URL, elements: [el('type-combobox', 'combobox', 'Application type')], text: '' },
        'type-options': { url: NORMAL_CLIENTS_URL, elements: [el('desktop-option', 'option', 'Desktop app')], text: '' },
        'name-field': {
          url: NORMAL_CLIENTS_URL,
          elements: [el('name-field-el', 'textbox', 'Name'), el('create-btn', 'button', 'Create')],
          text: '',
        },
        created: { url: NORMAL_CLIENTS_URL, elements: [], text: 'Something went sideways.' },
      },
      'clients-list',
      {
        'clients-list': { 'create-client-btn': 'type-select' },
        'type-select': { 'type-combobox': 'type-options' },
        'type-options': { 'desktop-option': 'name-field' },
        'name-field': { 'create-btn': 'created' },
      },
    );
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('credentials-not-readable');
  });
});

// ---------------------------------------------------------------------------
// requireElement typing sanity (exercised indirectly above; direct check here
// that the exported type shape is what the flows rely on).
// ---------------------------------------------------------------------------

describe('GoogleElementLookup shape', () => {
  test('a found lookup carries the element and nothing else misleading', () => {
    const lookup: GoogleElementLookup = requireElement([el('e1', 'button', 'Create')], { nameIncludes: 'create' });
    expect(lookup.found).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// Layer 2 — the adapter, against a fake BrowserEngine
// ---------------------------------------------------------------------------

/**
 * What Layer 2 used to be, and why it is not that any more.
 *
 * It launched a real Chromium against local HTML to prove the adapter's
 * snapshot-to-element mapping worked against a live DOM — and it was wrapped in
 * a browser-availability gate, so on any machine without a provisioned
 * browser it silently ran nothing. A test that reports success by not
 * executing is worse than no test: it occupies the space where the coverage
 * would go. The SDK's no-skipped-tests gate is what surfaced it.
 *
 * The engine's own behaviour against a real browser is covered by the browser
 * module's suite. What is unique to THIS adapter is the mapping — snapshot rows
 * to `GoogleBrowserElement`, the labelled untrusted-content envelope to text,
 * and the implicit session/page adoption — and all three are deterministic, so
 * they are proven here against a fake engine on every machine instead of on
 * some machines.
 */

interface FakeEngineCall {
  readonly method: string;
  readonly target: { sessionId?: string | undefined; pageId?: string | undefined };
}

function fakeEngine(overrides: Partial<Record<string, unknown>> = {}): {
  readonly engine: BrowserEngine;
  readonly calls: FakeEngineCall[];
} {
  const calls: FakeEngineCall[] = [];
  const record = (method: string, target: FakeEngineCall['target']): void => {
    calls.push({ method, target: { ...target } });
  };
  const engine = {
    navigate: async (target: FakeEngineCall['target']) => {
      record('navigate', target);
      return { sessionId: 's1', pageId: 'p1', url: 'https://example.com/landed', title: 'Landed' };
    },
    snapshot: async (target: FakeEngineCall['target']) => {
      record('snapshot', target);
      return {
        sessionId: 's1',
        pageId: 'p1',
        elements: [
          { ref: 'e1', role: 'button', name: 'Create' },
          { ref: 'e2', role: 'textbox', name: 'App name', value: 'prefilled' },
          { ref: 'e3', role: 'link', name: 'Integrate calendar' },
        ],
      };
    },
    readText: async (target: FakeEngineCall['target']) => {
      record('readText', target);
      return {
        sessionId: 's1',
        pageId: 'p1',
        url: 'https://example.com/landed',
        content: { text: 'the page said this' },
      };
    },
    click: async (target: FakeEngineCall['target']) => {
      record('click', target);
      return { sessionId: 's1', pageId: 'p1' };
    },
    type: async (target: FakeEngineCall['target']) => {
      record('type', target);
      return { sessionId: 's1', pageId: 'p1' };
    },
    ...overrides,
  } as unknown as BrowserEngine;
  return { engine, calls };
}

describe('createGoogleBrowserPort maps the engine onto the six-method port', () => {
  test('a snapshot row becomes a GoogleBrowserElement, with tag derived from role', async () => {
    const { engine } = fakeEngine();
    const port = createGoogleBrowserPort(engine);
    await port.navigate('https://example.com');
    const elements = await port.snapshot();

    expect(elements).toHaveLength(3);
    expect(elements[0]).toEqual({ ref: 'e1', role: 'button', name: 'Create', tag: 'button', value: undefined });
    // `value` survives when present — the calendar flow reads the iCal address
    // out of exactly that field.
    expect(elements[1]?.value).toBe('prefilled');
    expect(elements[1]?.tag).toBe('input');
    expect(elements[2]?.tag).toBe('a');
  });

  test('the real matchers work against the mapped elements', async () => {
    const { engine } = fakeEngine();
    const port = createGoogleBrowserPort(engine);
    await port.navigate('https://example.com');
    const elements = await port.snapshot();

    expect(findElement(elements, { role: 'button', nameIncludes: 'create' })?.ref).toBe('e1');
    expect(requireElement(elements, { nameIncludes: 'integrate calendar' }).found).toBe(true);
    const missing = requireElement(elements, { role: 'button', nameIncludes: 'publish app' });
    expect(missing.found).toBe(false);
    if (missing.found) throw new Error('unreachable');
    expect(missing.message).toContain('publish app');
    expect(missing.message).toContain('3 controls');
  });

  test('page text is unwrapped from the labelled envelope, not read off the top level', async () => {
    // The envelope is the untrusted-content boundary: page text travels with
    // its origin. An adapter that reached for a top-level `text` field read
    // undefined once that boundary landed, which is a regression worth pinning.
    const { engine } = fakeEngine();
    const port = createGoogleBrowserPort(engine);
    await port.navigate('https://example.com');
    expect(await port.readText()).toBe('the page said this');
  });

  test('an engine that returns no envelope fails loudly rather than reading undefined', async () => {
    const { engine } = fakeEngine({
      readText: async () => ({ sessionId: 's1', pageId: 'p1', url: 'https://x', text: 'bare string' }),
    });
    const port = createGoogleBrowserPort(engine);
    await port.navigate('https://example.com');
    await expect(port.readText()).rejects.toThrow(/labelled content envelope/);
  });

  test('the port owns one implicit session and page after the first navigate', async () => {
    const { engine, calls } = fakeEngine();
    const port = createGoogleBrowserPort(engine);

    await port.navigate('https://example.com');
    await port.snapshot();
    await port.click('e1');
    await port.type('e2', 'goodvibes-agent');
    await port.readText();

    // The first call goes out untargeted; every later one carries the adopted
    // session/page, so callers never see or pass a session id.
    expect(calls[0]?.target).toEqual({ sessionId: undefined, pageId: undefined });
    for (const call of calls.slice(1)) {
      expect(call.target).toEqual({ sessionId: 's1', pageId: 'p1' });
    }
  });

  test('currentUrl reads the url the engine reports, via a minimal text read', async () => {
    const { engine, calls } = fakeEngine();
    const port = createGoogleBrowserPort(engine);
    await port.navigate('https://example.com');
    expect(await port.currentUrl()).toBe('https://example.com/landed');
    expect(calls.some((call) => call.method === 'readText')).toBe(true);
  });
});
