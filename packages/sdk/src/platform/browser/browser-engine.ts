import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { BrowserSessionError, BrowserSessionManager, hasDisplay } from './browser-sessions.js';
import type { BrowserAttachOptions, BrowserLaunchOptions } from './browser-sessions.js';
import { describeProvisionWork } from './browser-provisioning.js';
import { resolveRef, SnapshotStore, StaleElementError, takeSnapshot } from './browser-snapshot.js';
import type {
  BrowserProvisionReport,
  BrowserSnapshot,
  OwnerApproval,
  UntrustedContentPort,
} from './browser-types.js';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_TEXT_LIMIT = 20_000;

/**
 * Schemes a page may be sent to.
 *
 * `javascript:` is refused outright. A javascript: URL is not navigation, it is
 * script injection into whatever is currently loaded, and it is exactly how a
 * bookmarklet ended up executing somewhere it was never meant to. Script that
 * needs to run in a page goes through action:"evaluate", which is scoped to a
 * page this engine controls and is reported as such.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:']);

export interface BrowserTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
}

export interface BrowserEngineOptions {
  /** Where screenshots are written. Must be a directory the product's read path can open. */
  readonly screenshotDirectory: string;
  /**
   * The product's untrusted-content contract. Required, and deliberately not
   * defaulted: an engine with no port would read pages and label nothing, which
   * is the boundary silently absent rather than a compile error. The
   * implementation is expected to be backed by the process-wide ledger every
   * other surface that reads stranger-written text also writes to — the email
   * surface most of all — so "read a page, then send a message" is visible as
   * one composition rather than two unrelated acts.
   */
  readonly untrusted: UntrustedContentPort;
  /** An owner approval covering an outward action in this turn, when one exists. */
  readonly approval?: OwnerApproval | null;
  /**
   * Records that this session wrote a file, so the product's read path can open
   * it afterwards. Optional: a surface with no session write ledger passes
   * nothing and screenshots are simply written and reported.
   */
  readonly recordSessionWrite?: ((path: string) => void) | undefined;
}

/** Fields the extraction contract can ask for. Nothing here can invoke anything. */
export type BrowserExtractField = 'text' | 'html' | 'value' | 'attributes';

/**
 * Runs in the page. Fixed, shipped in this file, and never assembled from
 * caller input: the caller only chooses which of these fields it wants.
 */
function readElementData(element: Element, fields: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
  for (const field of fields) {
    if (field === 'text') {
      const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
      data.text = text.replace(/\s+/g, ' ').trim().slice(0, 20_000);
    } else if (field === 'html') {
      data.html = element.outerHTML.slice(0, 20_000);
    } else if (field === 'value') {
      const input = element as HTMLInputElement;
      const type = (element.getAttribute('type') ?? '').toLowerCase();
      data.value = type === 'password' ? null : (input.value ?? null);
    } else if (field === 'attributes') {
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        attributes[attribute.name] = attribute.value.slice(0, 2_000);
      }
      data.attributes = attributes;
    }
  }
  return data;
}

export class UntrustedEffectError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'UntrustedEffectError';
  }
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new BrowserSessionError('No url was given to navigate to.', 'Pass url:"https://example.com".');
  }
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserSessionError(`"${rawUrl}" is not a usable URL.`, 'Pass a full URL such as https://example.com.');
  }
  if (parsed.protocol === 'javascript:') {
    throw new BrowserSessionError(
      'Navigating to a javascript: URL is not supported, because it runs script against whatever page is currently open instead of loading a page.',
      'Use action:"evaluate" to run script in a page this tool controls.',
    );
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new BrowserSessionError(
      `The ${parsed.protocol} scheme is not supported by the browser tool.`,
      'Use an http, https, file, or about URL.',
    );
  }
  return parsed.toString();
}

/**
 * The browser capability itself: provisioning, sessions, and every page
 * operation, with no Agent-surface types in sight.
 */
export class BrowserEngine {
  private readonly snapshots = new SnapshotStore();

  private readonly untrusted: UntrustedContentPort;
  private approval: OwnerApproval | null;

  constructor(
    private readonly sessions: BrowserSessionManager,
    private readonly options: BrowserEngineOptions,
  ) {
    this.untrusted = options.untrusted;
    this.approval = options.approval ?? null;
  }

  /**
   * Records that the owner asked for a specific outward action.
   *
   * Approval arrives mid-session, in the normal case: the agent reports what it
   * found on a page and the owner says to go ahead. Only the product's trust
   * contract can mint one of these, and only from a surface that carries
   * command authority, so nothing a page says can reach this.
   */
  setOwnerApproval(approval: OwnerApproval | null): void {
    this.approval = approval;
  }

  /** Records that page content entered the conversation, with where it came from. */
  private recordPageIngest(url: string): string {
    const origin = this.untrusted.originOf(url);
    this.untrusted.recordIngest({ origin, at: new Date().toISOString() });
    return origin;
  }

  /**
   * Refuses an outward action when this turn has read page content.
   *
   * This is the composition that matters: a page the agent just read must not
   * be able to cause the agent to act outwards. The refusal names what to do
   * instead, which is to take it to the owner.
   */
  private requireOutwardEffectAllowed(action: string, description: string): void {
    const decision = this.untrusted.evaluateOutwardEffect({
      action,
      description,
      approval: this.approval,
    });
    if (decision.allowed) return;
    throw new UntrustedEffectError(decision.reason ?? 'This action is not available here.', decision.fix ?? 'Ask the owner.');
  }

  sessionManager(): BrowserSessionManager {
    return this.sessions;
  }

  async provision(options: { readonly repair?: boolean; readonly allowDownload?: boolean } = {}): Promise<BrowserProvisionReport> {
    return this.sessions.provision(options);
  }

  async status(): Promise<Record<string, unknown>> {
    const report = this.sessions.provisionReport() ?? await this.sessions.provision({ allowDownload: false });
    return {
      browserAvailable: report.ok,
      binarySource: report.source,
      executablePath: report.executablePath,
      driverVersion: report.driverVersion,
      browsersPath: report.browsersPath,
      displayAvailable: hasDisplay(),
      defaultMode: hasDisplay() ? 'visible window' : 'headless (no display on this machine)',
      sessions: this.sessions.list(),
      ...(report.ok ? {} : { problem: report.problem, fix: report.fix }),
      provisionSteps: report.steps,
    };
  }

  async launch(options: BrowserLaunchOptions): Promise<Record<string, unknown>> {
    const session = await this.sessions.launch(options);
    return {
      session,
      // Setup that actually ran is reported, never swallowed: a first call that
      // spent two minutes installing a driver and a browser has to say so.
      ...this.setupReceipt(),
      note: session.headless
        ? 'Started headless. Pass headless:false to open a visible window for a sign-in.'
        : 'Started a visible window. Sign in once here and the profile keeps the login for later runs.',
    };
  }

  /** The one-act setup receipt for a call that may have provisioned something. */
  private setupReceipt(): { readonly setup?: string } {
    const setup = describeProvisionWork(this.sessions.provisionReport());
    return setup ? { setup } : {};
  }

  async attach(options: BrowserAttachOptions): Promise<Record<string, unknown>> {
    const session = await this.sessions.attach(options);
    const pages = await this.sessions.pageList(session.sessionId);
    return {
      session,
      pages,
      note: 'Attached to a browser this agent did not start. It will keep running; the agent cannot close it.',
    };
  }

  release(sessionId: string): Record<string, unknown> {
    const session = this.sessions.release(sessionId);
    return { released: session, note: 'Disconnected. The browser is still running.' };
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.sessions.closeSession(sessionId);
    return { closed: session };
  }

  private resolveSessionId(target: BrowserTarget): string {
    const sessionId = target.sessionId ?? this.sessions.defaultSessionId();
    if (!sessionId) {
      throw new BrowserSessionError(
        'No browser session is open.',
        'Call action:"launch" to start one, or action:"attach" to connect to a browser you already have running.',
      );
    }
    return sessionId;
  }

  private async target(target: BrowserTarget): Promise<{ readonly sessionId: string; readonly pageId: string; readonly page: Page }> {
    const sessionId = this.resolveSessionId(target);
    const { pageId, page } = await this.sessions.page(sessionId, target.pageId);
    return { sessionId, pageId, page };
  }

  /**
   * Opens a browser only if nothing is open yet, so the first call a model
   * makes is a useful one instead of an error telling it to call launch first.
   */
  private async ensureSession(target: BrowserTarget, launchOptions: BrowserLaunchOptions = {}): Promise<string> {
    if (target.sessionId) return target.sessionId;
    const existing = this.sessions.defaultSessionId();
    if (existing) return existing;
    // An implicitly opened session honors the same launch arguments an
    // explicit launch would, so headless:true on the first call is respected
    // instead of silently opening a window on someone's screen.
    const session = await this.sessions.launch(launchOptions);
    return session.sessionId;
  }

  async navigate(
    target: BrowserTarget,
    args: {
      readonly url: string;
      readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      readonly timeoutMs?: number;
      readonly launch?: BrowserLaunchOptions;
    },
  ): Promise<Record<string, unknown>> {
    const url = normalizeUrl(args.url);
    const sessionId = await this.ensureSession(target, args.launch ?? {});
    const { pageId, page } = await this.sessions.page(sessionId, target.pageId);
    const response = await page.goto(url, {
      waitUntil: args.waitUntil ?? 'domcontentloaded',
      timeout: args.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    });
    this.snapshots.clear(sessionId, pageId);
    return {
      sessionId,
      pageId,
      url: page.url(),
      title: await page.title().catch(() => ''),
      httpStatus: response?.status() ?? null,
      ...this.setupReceipt(),
      next: 'Call action:"snapshot" to get element refs for this page.',
    };
  }

  async snapshot(target: BrowserTarget, args: { readonly limit?: number } = {}): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const snapshot = await takeSnapshot(page, sessionId, pageId, args);
    this.snapshots.set(snapshot);
    // Element names and values are written by the page, so a snapshot is
    // untrusted content just as much as the body text is.
    const origin = this.recordPageIngest(snapshot.url);
    return {
      sessionId,
      pageId,
      url: snapshot.url,
      title: snapshot.title,
      contentTrust: 'untrusted',
      origin,
      rule: this.untrusted.rule,
      snapshotId: snapshot.snapshotId,
      elementCount: snapshot.elements.length,
      truncated: snapshot.truncated,
      elements: snapshot.elements.map((element) => ({
        ref: element.ref,
        role: element.role,
        name: element.name,
        ...(element.value === undefined ? {} : { value: element.value }),
        ...(element.disabled === undefined ? {} : { disabled: element.disabled }),
        ...(element.checked === undefined ? {} : { checked: element.checked }),
      })),
    };
  }

  private currentSnapshot(sessionId: string, pageId: string): BrowserSnapshot | null {
    return this.snapshots.get(sessionId, pageId);
  }

  async click(
    target: BrowserTarget,
    args: { readonly ref: string; readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: number; readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    if (element.submits) {
      // Submitting sends data to whoever runs the site. Whether this element
      // submits was recorded when the page was snapshotted, so this is a fact
      // about the control rather than a guess about the click.
      this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} by activating ${element.role} "${element.name}"`,
      );
    }
    const urlBefore = page.url();
    await locator.click({
      button: args.button ?? 'left',
      clickCount: args.clickCount ?? 1,
      timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    });
    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_ACTION_TIMEOUT_MS }).catch(() => undefined);
    this.snapshots.clear(sessionId, pageId);
    return {
      sessionId,
      pageId,
      clicked: { ref: args.ref, role: element.role, name: element.name },
      urlBefore,
      url: page.url(),
      navigated: page.url() !== urlBefore,
      next: 'Refs are cleared after a click. Call action:"snapshot" for current refs.',
    };
  }

  /**
   * Types into a resolved element. There is no variant that types into "the
   * focused window": the text goes to this element in this page or the call
   * fails.
   */
  async type(
    target: BrowserTarget,
    args: {
      readonly ref: string;
      readonly text: string;
      readonly submit?: boolean;
      readonly replace?: boolean;
      readonly timeoutMs?: number;
    },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    if (args.submit === true) {
      this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} after typing into ${element.role} "${element.name}"`,
      );
    }
    if (args.replace === false) {
      await locator.click({ timeout });
      await locator.pressSequentially(args.text, { timeout });
    } else {
      await locator.fill(args.text, { timeout });
    }
    let submitted = false;
    if (args.submit === true) {
      await locator.press('Enter', { timeout });
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined);
      submitted = true;
    }
    if (submitted) this.snapshots.clear(sessionId, pageId);
    return {
      sessionId,
      pageId,
      typedInto: { ref: args.ref, role: element.role, name: element.name },
      submitted,
      url: page.url(),
    };
  }

  async select(
    target: BrowserTarget,
    args: { readonly ref: string; readonly values: readonly string[]; readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    const selected = await locator.selectOption([...args.values], { timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
    return { sessionId, pageId, selectedIn: { ref: args.ref, role: element.role, name: element.name }, selected };
  }

  async press(
    target: BrowserTarget,
    args: { readonly ref: string; readonly key: string; readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    if (args.key === 'Enter' || args.key === 'NumpadEnter') {
      this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} by pressing ${args.key} in ${element.role} "${element.name}"`,
      );
    }
    await locator.press(args.key, { timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
    this.snapshots.clear(sessionId, pageId);
    return { sessionId, pageId, pressed: args.key, on: { ref: args.ref, role: element.role, name: element.name }, url: page.url() };
  }

  async scroll(
    target: BrowserTarget,
    args: { readonly ref?: string; readonly direction?: 'up' | 'down'; readonly amount?: number },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    if (args.ref) {
      const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
      await locator.scrollIntoViewIfNeeded({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
      return { sessionId, pageId, scrolledTo: { ref: args.ref, role: element.role, name: element.name } };
    }
    const amount = args.amount ?? 600;
    const delta = args.direction === 'up' ? -amount : amount;
    await page.mouse.wheel(0, delta);
    const position = await page.evaluate(() => ({ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight }));
    return { sessionId, pageId, scrolledBy: delta, ...position };
  }

  async waitFor(
    target: BrowserTarget,
    args: { readonly text?: string; readonly url?: string; readonly timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const timeout = args.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    if (args.text) {
      await page.getByText(args.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
      this.snapshots.clear(sessionId, pageId);
      return { sessionId, pageId, waitedFor: { text: args.text }, url: page.url(), found: true };
    }
    if (args.url) {
      await page.waitForURL(args.url, { timeout });
      this.snapshots.clear(sessionId, pageId);
      return { sessionId, pageId, waitedFor: { url: args.url }, url: page.url(), found: true };
    }
    await page.waitForLoadState('networkidle', { timeout });
    return { sessionId, pageId, waitedFor: { state: 'networkidle' }, url: page.url(), found: true };
  }

  async readText(target: BrowserTarget, args: { readonly maxChars?: number } = {}): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const limit = Math.max(200, Math.min(200_000, args.maxChars ?? DEFAULT_TEXT_LIMIT));
    // innerText ignores shadow DOM, so a page that renders its content inside a
    // component would read as empty. Open shadow roots are walked and appended.
    const text = await page.evaluate(() => {
      const collectShadowText = (root: Document | ShadowRoot): string[] => {
        const parts: string[] = [];
        for (const element of Array.from(root.querySelectorAll('*'))) {
          const shadow = element.shadowRoot;
          if (!shadow) continue;
          const inner = (shadow as unknown as { readonly textContent?: string }).textContent ?? '';
          if (inner.trim()) parts.push(inner.replace(/\s+/g, ' ').trim());
          parts.push(...collectShadowText(shadow));
        }
        return parts;
      };
      const body = document.body?.innerText ?? '';
      const shadow = collectShadowText(document);
      return shadow.length > 0 ? `${body}\n${shadow.join('\n')}` : body;
    });
    // Embedded frames carry their own content from their own origin. Leaving
    // them out means reading a page and missing the part that mattered, and
    // each frame's origin is recorded separately because a frame is a
    // different author with the same access to this page.
    const frameTexts: string[] = [];
    for (const frame of page.frames()) {
      // The main frame is already read above. Identity comparison is not enough
      // for a host-backed page, whose frame objects are created per call, so the
      // main frame is the one with no parent.
      if (frame === page.mainFrame() || frame.parentFrame() === null) continue;
      const frameText = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (!frameText.trim()) continue;
      this.recordPageIngest(frame.url());
      frameTexts.push(`\n\n[embedded frame ${this.untrusted.originOf(frame.url())}]\n${frameText.trim()}`);
    }
    const normalized = `${text}${frameTexts.join('')}`.replace(/\n{3,}/g, '\n\n').trim();
    const origin = this.recordPageIngest(page.url());
    return {
      sessionId,
      pageId,
      url: page.url(),
      title: await page.title().catch(() => ''),
      // The page's words, labelled as the page's words. The envelope carries
      // the origin and the standing rule with the text wherever it goes next.
      content: this.untrusted.label({
        origin,
        text: normalized.slice(0, limit),
        truncated: normalized.length > limit,
      }),
      truncated: normalized.length > limit,
    };
  }

  async screenshot(
    target: BrowserTarget,
    args: { readonly fullPage?: boolean; readonly path?: string } = {},
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    mkdirSync(this.options.screenshotDirectory, { recursive: true });
    const fileName = `${sessionId}-${pageId}-${String(Date.now())}.png`;
    // Resolved once, so the path written, the path recorded, and the path
    // returned to the model are the same string. The ledger matches on exact
    // spelling and deliberately does not guess a working directory at read
    // time, so an unresolved relative path here would record one spelling and
    // hand back another.
    const path = resolve(args.path ?? join(this.options.screenshotDirectory, fileName));
    const buffer = await page.screenshot({ path, fullPage: args.fullPage === true });
    // Recorded as written by this session, which is what lets the agent open
    // the file it just made even though it lives under a dotted storage root.
    //
    // Declared explicitly rather than inferred from the tool-event stream: that
    // classifier deliberately refuses to grant a waiver for browser and shell
    // writes, because those paths did not pass through the model. This one did
    // not either — but the browser engine KNOWS it just created this exact
    // file, which is the case the explicit entry point exists for.
    this.options.recordSessionWrite?.(path);
    return {
      sessionId,
      pageId,
      url: page.url(),
      path,
      bytes: buffer.byteLength,
      next: `Open it with read path:"${path}".`,
    };
  }

  async tabs(target: BrowserTarget): Promise<Record<string, unknown>> {
    const sessionId = this.resolveSessionId(target);
    return { sessionId, pages: await this.sessions.pageList(sessionId) };
  }

  async newTab(
    target: BrowserTarget,
    args: { readonly url?: string; readonly launch?: BrowserLaunchOptions } = {},
  ): Promise<Record<string, unknown>> {
    const sessionId = await this.ensureSession(target, args.launch ?? {});
    const { pageId, page } = await this.sessions.newPage(sessionId);
    if (args.url) {
      await page.goto(normalizeUrl(args.url), { waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
    }
    return { sessionId, pageId, url: page.url(), pages: await this.sessions.pageList(sessionId) };
  }

  switchTab(target: BrowserTarget, args: { readonly pageId: string }): Record<string, unknown> {
    const sessionId = this.resolveSessionId(target);
    this.sessions.setActivePage(sessionId, args.pageId);
    return { sessionId, activePageId: args.pageId };
  }

  async closeTab(target: BrowserTarget, args: { readonly pageId: string }): Promise<Record<string, unknown>> {
    const sessionId = this.resolveSessionId(target);
    const { page } = await this.sessions.page(sessionId, args.pageId);
    await page.close();
    this.snapshots.clear(sessionId, args.pageId);
    return { sessionId, closedPageId: args.pageId, pages: await this.sessions.pageList(sessionId) };
  }

  async goBack(target: BrowserTarget): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const response = await page.goBack({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
    this.snapshots.clear(sessionId, pageId);
    return { sessionId, pageId, url: page.url(), moved: response !== null };
  }

  async goForward(target: BrowserTarget): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const response = await page.goForward({ timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
    this.snapshots.clear(sessionId, pageId);
    return { sessionId, pageId, url: page.url(), moved: response !== null };
  }

  /**
   * Reads data out of the page.
   *
   * This replaced an `evaluate` action that ran caller-supplied JavaScript in
   * the page. That action was guarded by searching the source for `fetch`,
   * `sendBeacon` and friends — a denylist standing between attacker-influenced
   * text and arbitrary code execution, which is a losing shape. An expression
   * built as `globalThis[atob('ZmV0Y2g=')]` defeats a string match while doing
   * exactly what the match existed to stop.
   *
   * So there is no longer any way to express code here. The caller supplies a
   * CSS selector or a ref and names the fields it wants; the function that runs
   * in the page is fixed, ships in this file, and reads DOM properties. A
   * network call is not something this contract can describe — not something we
   * try to notice.
   *
   * What that costs: running page functions, computing values in-page, and
   * poking at application state that never reaches the DOM. Interaction still
   * happens through click, type, select and press, which are checked; anything
   * computed can be computed here, from extracted data, where a page cannot
   * reach it.
   */
  async extract(
    target: BrowserTarget,
    args: {
      readonly ref?: string;
      readonly selector?: string;
      readonly fields?: readonly BrowserExtractField[];
      readonly all?: boolean;
      readonly limit?: number;
    },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const fields = args.fields && args.fields.length > 0 ? args.fields : (['text'] as const);
    const limit = Math.max(1, Math.min(200, args.limit ?? (args.all === true ? 50 : 1)));

    let matched: number;
    const extracted: unknown[] = [];
    if (args.ref) {
      const { locator } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
      matched = 1;
      extracted.push(await locator.evaluate(readElementData, [...fields]));
    } else {
      const selector = args.selector?.trim() || 'body';
      const all = page.locator(selector);
      matched = await all.count().catch(() => 0);
      if (matched === 0) {
        throw new BrowserSessionError(
          `Nothing on this page matches ${selector}.`,
          'Call action:"snapshot" to see what is on the page, then extract by ref or by a selector that matches.',
        );
      }
      const take = args.all === true ? Math.min(matched, limit) : 1;
      for (let index = 0; index < take; index += 1) {
        extracted.push(await all.nth(index).evaluate(readElementData, [...fields]));
      }
    }

    const origin = this.recordPageIngest(page.url());
    return {
      sessionId,
      pageId,
      url: page.url(),
      matched,
      returned: extracted.length,
      ...(matched > extracted.length
        ? { note: `Showing ${String(extracted.length)} of ${String(matched)} matches. Pass all:true with a limit to read more.` }
        : {}),
      // Whatever the page holds is still the page's own words.
      data: this.untrusted.label({
        origin,
        text: JSON.stringify(extracted),
      }),
    };
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}

export { BrowserSessionError, StaleElementError };
