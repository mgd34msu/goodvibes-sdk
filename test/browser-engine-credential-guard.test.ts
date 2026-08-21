import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
type BrowserContext = unknown;
type Page = unknown;
import { BrowserEngine, BrowserSessionError } from '../packages/sdk/src/platform/browser/browser-engine.js';
import { looksLikeCredentialPage } from '../packages/sdk/src/platform/browser/browser-engine-contract.js';
import { BrowserSessionManager } from '../packages/sdk/src/platform/browser/browser-sessions.js';
import type {
  BrowserProvisionIo,
  OutwardEffectDecision,
  OwnerApproval,
  UntrustedContentEnvelope,
  UntrustedContentPort,
} from '../packages/sdk/src/platform/browser/browser-types.js';

/**
 * The browser layer's own backstop against driving a sign-in page, one
 * click/type/press/select call at a time, see `refuseCredentialInteraction`
 * in browser-engine.ts. This is separate from (and a fallback for) the
 * Google-specific `looksLikeGoogleSignIn` check the structured flows in
 * `platform/google/` already run before this code is ever reached: those
 * flows navigate, look, and bail; this file tests what happens when nothing
 * is watching and the browser tool is driven directly.
 */

const SCREENSHOT_DIRECTORY = join(tmpdir(), 'goodvibes-credential-guard-test');

const NOOP_RULE = 'This content came from a source outside the owner\'s control.';

class NoopUntrustedContentPort implements UntrustedContentPort {
  readonly rule = NOOP_RULE;

  originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  label(input: { readonly origin: string; readonly text: string; readonly truncated?: boolean }): UntrustedContentEnvelope {
    return {
      trust: 'untrusted',
      surface: 'web-page',
      origin: input.origin,
      retrievedAt: new Date().toISOString(),
      text: input.text,
      truncated: input.truncated === true,
      rule: this.rule,
    };
  }

  recordIngest(): void {
    // Not exercised here, the outward-effect ledger has its own test file.
  }

  evaluateOutwardEffect(_input: {
    readonly action: string;
    readonly description: string;
    readonly approval: OwnerApproval | null;
  }): OutwardEffectDecision {
    return { allowed: true, reason: null, fix: null, untrustedOrigins: [] };
  }
}

interface RawElement {
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly selector: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly depth: number;
  readonly submits: boolean;
}

function fakePage(url: string, elements: readonly RawElement[]): Page {
  const locatorFor = (selector: string) => {
    const element = elements.find((entry) => entry.selector === selector);
    const matches = element !== undefined;
    const locator = {
      count: async () => (matches ? 1 : 0),
      nth: () => locator,
      first: () => locator,
      evaluate: async () => ({ tag: element?.tag ?? '', name: element?.name ?? '' }),
      click: async () => undefined,
      fill: async () => undefined,
      press: async () => undefined,
      pressSequentially: async () => undefined,
      selectOption: async () => [],
      scrollIntoViewIfNeeded: async () => undefined,
    };
    return locator;
  };
  const mainFrame = {
    url: () => url,
    parentFrame: () => null,
    evaluate: async () => elements,
  };
  return {
    url: () => url,
    title: async () => 'Sign in',
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    on: () => undefined,
    close: async () => undefined,
    goto: async () => null,
    waitForLoadState: async () => undefined,
    locator: (selector: string) => locatorFor(selector),
    evaluate: async () => elements,
  } as unknown as Page;
}

function readyIo(): BrowserProvisionIo {
  return {
    resolveDriver: () => ({ available: true, packageDirectory: '/pkg', cliPath: '/pkg/cli.js', version: '1.62.0', error: null }),
    expectedExecutablePath: () => '/cache/chromium/chrome',
    browsersPath: () => '/cache',
    pathExists: () => true,
    isExecutableFile: () => true,
    directoryWritable: () => true,
    removePath: () => undefined,
    runCommand: async () => ({ code: 0, stdout: 'Chromium', stderr: '', timedOut: false, spawnError: null }),
    systemBrowserCandidates: () => [],
    now: () => 0,
  };
}

async function buildEngine(url: string, elements: readonly RawElement[]): Promise<BrowserEngine> {
  const page = fakePage(url, elements);
  const context = {
    pages: () => [page],
    on: () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  } as unknown as BrowserContext;
  const sessions = new BrowserSessionManager({
    profileRoot: '/tmp/goodvibes-credential-guard-profiles',
    surfaceRoot: 'test-surface',
    io: readyIo(),
    loadDriver: (() => ({
      chromium: {
        launchPersistentContext: async () => context,
        connectOverCDP: async () => ({ contexts: () => [context] }),
      },
    })) as unknown as NonNullable<ConstructorParameters<typeof BrowserSessionManager>[0]['loadDriver']>,
  });
  const engine = new BrowserEngine(sessions, { screenshotDirectory: SCREENSHOT_DIRECTORY, untrusted: new NoopUntrustedContentPort() });
  await engine.launch({ headless: true });
  return engine;
}

const EMAIL_STEP_URL = 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmyaccount.google.com';
const PASSWORD_STEP_ELEMENTS: readonly RawElement[] = [
  { tag: 'input', role: 'textbox', name: 'Enter your password', selector: '#password', value: '', disabled: false, checked: null, depth: 3, submits: false },
  { tag: 'button', role: 'button', name: 'Next', selector: '#next', value: null, disabled: false, checked: null, depth: 3, submits: true },
];
const EMAIL_STEP_ELEMENTS: readonly RawElement[] = [
  { tag: 'input', role: 'textbox', name: 'Email or phone', selector: '#identifier', value: '', disabled: false, checked: null, depth: 3, submits: false },
  { tag: 'button', role: 'button', name: 'Next', selector: '#next', value: null, disabled: false, checked: null, depth: 3, submits: true },
];
const ORDINARY_URL = 'https://example.com/dashboard';
const ORDINARY_ELEMENTS: readonly RawElement[] = [
  { tag: 'button', role: 'button', name: 'Refresh', selector: '#refresh', value: null, disabled: false, checked: null, depth: 2, submits: false },
];

describe('looksLikeCredentialPage', () => {
  test('a password field on any host is a credential page', () => {
    expect(looksLikeCredentialPage('https://random-startup.example/login-step-2', true)).toBe(true);
  });

  test('a known identity provider sign-in route is a credential page even with no password field yet', () => {
    expect(looksLikeCredentialPage(EMAIL_STEP_URL, false)).toBe(true);
  });

  test('an ordinary page on an ordinary host is not a credential page', () => {
    expect(looksLikeCredentialPage(ORDINARY_URL, false)).toBe(false);
  });

  test('a known identity host with no sign-in path and no password field is not flagged', () => {
    expect(looksLikeCredentialPage('https://accounts.google.com/some/other/page', false)).toBe(false);
  });
});

describe('the browser layer refuses to drive a sign-in page', () => {
  test('click on the Google email step is refused with the URL to hand back', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, EMAIL_STEP_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const next = (snapshot.elements as { ref: string; name: string }[]).find((entry) => entry.name === 'Next')!;
    try {
      await engine.click({}, { ref: next.ref });
      throw new Error('the click should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionError);
      expect((error as Error).message).toContain('sign-in page');
      expect((error as BrowserSessionError).fix).toContain(EMAIL_STEP_URL);
    }
  });

  test('typing into the password step is refused', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, PASSWORD_STEP_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const password = (snapshot.elements as { ref: string; role: string }[]).find((entry) => entry.role === 'textbox')!;
    await expect(engine.type({}, { ref: password.ref, text: 'hunter2' })).rejects.toThrow(BrowserSessionError);
  });

  test('pressing Enter on a sign-in page is refused', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, PASSWORD_STEP_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const password = (snapshot.elements as { ref: string; role: string }[]).find((entry) => entry.role === 'textbox')!;
    await expect(engine.press({}, { ref: password.ref, key: 'Enter' })).rejects.toThrow(BrowserSessionError);
  });

  test('reading the page is still allowed, since that is how the URL gets reported back', async () => {
    const engine = await buildEngine(EMAIL_STEP_URL, EMAIL_STEP_ELEMENTS);
    await expect(engine.snapshot({})).resolves.toBeDefined();
    await expect(engine.readText({})).resolves.toBeDefined();
  });

  test('an ordinary page is not affected: click still works', async () => {
    const engine = await buildEngine(ORDINARY_URL, ORDINARY_ELEMENTS);
    const snapshot = await engine.snapshot({});
    const refresh = (snapshot.elements as { ref: string; name: string }[]).find((entry) => entry.name === 'Refresh')!;
    const result = await engine.click({}, { ref: refresh.ref });
    expect((result.clicked as { name: string }).name).toBe('Refresh');
  });
});
