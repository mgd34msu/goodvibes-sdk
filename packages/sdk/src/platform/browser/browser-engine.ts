import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { BrowserSessionError, BrowserSessionManager, hasDisplay } from './browser-sessions.js';
import type { BrowserAttachOptions, BrowserLaunchOptions } from './browser-sessions.js';
import { describeProvisionWork } from './browser-provisioning.js';
import { resolveRef, SnapshotStore, StaleElementError, takeSnapshot } from './browser-snapshot.js';
import { assertCaptureAllowed, fillSecretsIntoPage } from './browser-secret-fill.js';
import type {
  BrowserProvisionReport,
  BrowserSnapshot,
  CardFieldGuard,
  OwnerApproval,
  UntrustedContentPort,
} from './browser-types.js';


// The engine's option/target types, its error and the two pure helpers moved
// to browser-engine-contract.ts when the untrusted-content boundary and the
// card-field guard together took this file past the 800-line cap. Re-exported
// below so the platform/browser barrel's surface is unchanged.
import {
  credentialPageRefusal,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_TEXT_LIMIT,
  launchNote,
  normalizeUrl,
  readElementData,
  UntrustedEffectError,
} from './browser-engine-contract.js';
import type {
  BrowserEngineOptions,
  BrowserExtractField,
  BrowserTarget,
} from './browser-engine-contract.js';

export { UntrustedEffectError };
export type { BrowserEngineOptions, BrowserExtractField, BrowserTarget };


/**
 * The browser capability itself: provisioning, sessions, and every page
 * operation, with no Agent-surface types in sight.
 */
export class BrowserEngine {
  private readonly snapshots = new SnapshotStore();

  private readonly untrusted: UntrustedContentPort;
  private readonly cardGuard: CardFieldGuard | null;
  private approval: OwnerApproval | null;

  constructor(
    private readonly sessions: BrowserSessionManager,
    private readonly options: BrowserEngineOptions,
  ) {
    this.untrusted = options.untrusted;
    this.cardGuard = options.cardFieldGuard ?? null;
    this.approval = options.approval ?? null;
  }

  /** Whether this engine can be used to pay for something (see fill-card.ts). */
  cardFieldGuardInstalled(): boolean {
    return this.cardGuard !== null;
  }

  cardFieldGuard(): CardFieldGuard | null {
    return this.cardGuard;
  }

  /**
   * Strip live card material out of anything a page produced. Applied to every
   * value, name, body text, extracted field and ledger entry leaving this
   * class, unconditionally, see `CardFieldGuard` in browser-types.ts.
   */
  private scrub(sessionId: string, pageId: string, text: string): string {
    return this.cardGuard === null ? text : this.cardGuard.redact(sessionId, pageId, text);
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

  /**
   * Records that page content entered the conversation, with where it came
   * from AND what it said.
   *
   * The text matters as much as the origin. Without it, a later outward action
   * can only be judged on "did this turn read anything", which in a daemon is
   * permanently true, so every send would be refused and the boundary would
   * be switched off. With it, the guard can ask the answerable question:
   * does what is about to leave derive from what was read.
   */
  private recordPageIngest(url: string, content?: string): string {
    const origin = this.untrusted.originOf(url);
    this.untrusted.recordIngest({
      origin,
      at: new Date().toISOString(),
      ...(content === undefined ? {} : { content }),
    });
    return origin;
  }

  /**
   * Refuses an outward action when this turn has read page content.
   *
   * This is the composition that matters: a page the agent just read must not
   * be able to cause the agent to act outwards. The refusal names what to do
   * instead, which is to take it to the owner.
   *
   * `content` is what is about to be submitted, when the caller could work it
   * out. Supplying it turns the coarse question into the answerable one, does
   * this submission repeat what was read, which is the difference between a
   * form filled from the owner's instruction going through and every form on a
   * browsing session being refused.
   */
  private async requireOutwardEffectAllowed(
    action: string,
    description: string,
    content?: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    const hadApproval = this.approval !== null;
    try {
      const decision = this.untrusted.evaluateOutwardEffect({
        action,
        description,
        approval: this.approval,
        ...(content === undefined ? {} : { content }),
      });
      if (decision.allowed) return;
      throw new UntrustedEffectError(decision.reason ?? 'This action is not available here.', decision.fix ?? 'Ask the owner.');
    } finally {
      // `armSubmitApproval` (routes/browser-composition.ts) documents itself as
      // covering exactly ONE outward submit. A TTL alone does not enforce that,
      // an approval that sits unconsumed authorises every submit until it
      // expires, so it is spent here, on the first submit check it was live
      // for, whatever that check decided.
      if (hadApproval && action === 'browser.submit') this.approval = null;
    }
  }

  /**
   * The values in the form this element belongs to, as the fields about to
   * leave the machine.
   *
   * Read live rather than remembered: the page may have filled, rewritten or
   * defaulted anything since the snapshot, and what matters is what will
   * actually be posted. Field names come from `name`/`id`, so a refusal can say
   * which input carried the overlap instead of pointing at an index.
   *
   * Password values are read but never returned. A password is high-entropy by
   * construction, so it contributes nothing to a derivation check, while
   * putting one into a `TaintFinding` excerpt would print it in a refusal
   * message, the check would have leaked what it was defending.
   *
   * Returns undefined when the values cannot be established: the element is
   * outside a form, the page is cross-origin-restricted, the evaluate times
   * out. That is the honest answer, and it drops this call to the coarse rule
   * rather than to a false "nothing overlaps".
   */
  private static async enclosingFormFields(
    locator: Locator,
  ): Promise<Readonly<Record<string, string | undefined>> | undefined> {
    try {
      const fields = await locator.evaluate((node: Element) => {
        const owner = (node as HTMLInputElement).form ?? node.closest('form');
        if (!owner) return null;
        const out: Record<string, string> = {};
        let index = 0;
        for (const control of Array.from(owner.elements)) {
          const input = control as HTMLInputElement;
          const type = (input.type ?? '').toLowerCase();
          if (type === 'password' || type === 'hidden' || type === 'file') continue;
          if (type === 'checkbox' || type === 'radio') {
            if (!input.checked) continue;
          }
          const value = typeof input.value === 'string' ? input.value : '';
          if (value.trim().length === 0) continue;
          index += 1;
          const name = input.name || input.id || `field ${String(index)}`;
          out[name] = value;
        }
        return out;
      });
      if (fields === null) return undefined;
      return Object.keys(fields).length === 0 ? undefined : fields;
    } catch {
      // A page that will not answer is not a page that has proved itself safe.
      return undefined;
    }
  }

  sessionManager(): BrowserSessionManager {
    return this.sessions;
  }

  async provision(options: { readonly repair?: boolean | undefined; readonly allowDownload?: boolean | undefined } = {}): Promise<BrowserProvisionReport> {
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
      note: launchNote(session),
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
    // Every page's material in this session is gone with the browser that held
    // it. Material bound to a page that outlives the session it was typed in
    // would be material with no page left to be redacted out of.
    this.cardGuard?.disarmSession?.(sessionId);
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
      readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
      readonly timeoutMs?: number | undefined;
      readonly launch?: BrowserLaunchOptions | undefined;
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
    // A navigation replaces the whole document, so whatever card material was
    // typed into the previous DOM is gone with it. Material lifetime is bound
    // to the page it is on, not to whichever flow last had an opinion about it.
    this.cardGuard?.disarm(sessionId, pageId);
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

  async snapshot(target: BrowserTarget, args: { readonly limit?: number | undefined } = {}): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    // The guard goes IN rather than being applied to the result: the snapshot
    // is also stored for ref resolution, and a stored copy holding the card
    // would be the same leak one indirection further away.
    const snapshot = await takeSnapshot(page, sessionId, pageId, {
      ...args,
      ...(this.cardGuard === null ? {} : { guard: this.cardGuard }),
    });
    this.snapshots.set(snapshot);
    // Element names and values are written by the page, so a snapshot is
    // untrusted content just as much as the body text is.
    const origin = this.recordPageIngest(
      snapshot.url,
      snapshot.elements.map((element) => `${element.name} ${element.value ?? ''}`).join('\n'),
    );
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

  /**
   * Refuses to drive a sign-in page. Called before every interactive action
   * (click, type, press, select), never before a read-only one, since
   * reading is exactly what lets the caller notice a sign-in page and hand
   * the URL back instead of clicking through it. See `credentialPageRefusal`
   * in browser-engine-contract.ts for what counts as a sign-in page and why:
   * this method is only the plumbing that gets it a URL and the last snapshot.
   */
  private refuseCredentialInteraction(sessionId: string, pageId: string, page: Page, action: string): void {
    const refusal = credentialPageRefusal(page.url(), this.currentSnapshot(sessionId, pageId)?.elements ?? [], action);
    if (refusal) throw new BrowserSessionError(refusal.message, refusal.fix);
  }

  async click(
    target: BrowserTarget,
    args: { readonly ref: string; readonly button?: 'left' | 'right' | 'middle' | undefined; readonly clickCount?: number | undefined; readonly timeoutMs?: number | undefined },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    this.refuseCredentialInteraction(sessionId, pageId, page, 'click');
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    if (element.submits) {
      // Submitting sends data to whoever runs the site. Whether this element
      // submits was recorded when the page was snapshotted, so this is a fact
      // about the control rather than a guess about the click.
      //
      // The form's current values are what will actually be posted, so they are
      // the fields the derivation check should see. Read live; undefined when
      // the element is outside a form or the page will not answer, which drops
      // this call to the coarse rule rather than to a false clean bill.
      await this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} by activating ${element.role} "${element.name}"`,
        await BrowserEngine.enclosingFormFields(locator),
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
    const navigated = page.url() !== urlBefore;
    // A navigating click replaces the DOM exactly as an explicit navigate does,
    // so whatever card material was on the page it left is gone with it.
    if (navigated) this.cardGuard?.disarm(sessionId, pageId);
    return {
      sessionId,
      pageId,
      clicked: { ref: args.ref, role: element.role, name: element.name },
      urlBefore,
      url: page.url(),
      navigated,
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
      readonly submit?: boolean | undefined;
      readonly replace?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    this.refuseCredentialInteraction(sessionId, pageId, page, 'type');
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    const timeout = args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    if (args.submit === true) {
      // The text about to be typed is named explicitly as well as read back off
      // the form, because the fill has not happened yet at this point: the
      // guard runs BEFORE anything is entered, so a body lifted from a page
      // cannot be typed into a field and then submitted while the check looks
      // at the pre-fill state.
      await this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} after typing into ${element.role} "${element.name}"`,
        { ...(await BrowserEngine.enclosingFormFields(locator) ?? {}), [element.name || 'typed text']: args.text },
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

  /**
   * Type several DAEMON-held values in one motion, every ref resolved against
   * the snapshot in place before any of them is typed. Values never come from
   * the model. The mechanics live in browser-secret-fill.ts.
   *
   * The caller arms the guard once before calling this, for the whole batch.
   *
   * A field-by-field version of this cleared the snapshot after every field,
   * so the second field's ref pointed at nothing by the time its turn came.
   * This clears it once, only on failure: nothing then types into a page
   * nobody will click. A full success leaves the snapshot in place, still
   * fresh since nothing here navigates, so the submit click a filled card is
   * always followed by still resolves; that click clears it, as every click
   * already does.
   */
  async fillSecretBatch(
    target: BrowserTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string }[]; readonly timeoutMs?: number | undefined },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    const outcome = await fillSecretsIntoPage({
      page,
      snapshot: this.currentSnapshot(sessionId, pageId),
      fills: args.fills,
      guard: this.cardGuard,
      timeoutMs: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    });
    if (!outcome.ok) this.snapshots.clear(sessionId, pageId);
    return {
      sessionId,
      pageId,
      url: page.url(),
      filled: outcome.filled,
      failedRef: outcome.failedRef,
    };
  }

  async select(
    target: BrowserTarget,
    args: { readonly ref: string; readonly values: readonly string[]; readonly timeoutMs?: number | undefined },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    this.refuseCredentialInteraction(sessionId, pageId, page, 'select');
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    const selected = await locator.selectOption([...args.values], { timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
    return { sessionId, pageId, selectedIn: { ref: args.ref, role: element.role, name: element.name }, selected };
  }

  async press(
    target: BrowserTarget,
    args: { readonly ref: string; readonly key: string; readonly timeoutMs?: number | undefined },
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    this.refuseCredentialInteraction(sessionId, pageId, page, 'press');
    const { locator, element } = await resolveRef(page, this.currentSnapshot(sessionId, pageId), args.ref);
    if (args.key === 'Enter' || args.key === 'NumpadEnter') {
      await this.requireOutwardEffectAllowed(
        'browser.submit',
        `submit the form on ${this.untrusted.originOf(page.url())} by pressing ${args.key} in ${element.role} "${element.name}"`,
        await BrowserEngine.enclosingFormFields(locator),
      );
    }
    await locator.press(args.key, { timeout: args.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
    this.snapshots.clear(sessionId, pageId);
    return { sessionId, pageId, pressed: args.key, on: { ref: args.ref, role: element.role, name: element.name }, url: page.url() };
  }

  async scroll(
    target: BrowserTarget,
    args: { readonly ref?: string | undefined; readonly direction?: 'up' | 'down' | undefined; readonly amount?: number | undefined },
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
    args: { readonly text?: string | undefined; readonly url?: string | undefined; readonly timeoutMs?: number | undefined },
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

  async readText(target: BrowserTarget, args: { readonly maxChars?: number | undefined } = {}): Promise<Record<string, unknown>> {
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
    // Scrubbed before it is labelled, recorded, or returned. A page is free to
    // render what was typed into it as ordinary body text, and this is the path
    // that would hand that straight back.
    const normalized = this.scrub(
      sessionId,
      pageId,
      `${text}${frameTexts.join('')}`.replace(/\n{3,}/g, '\n\n').trim(),
    );
    const origin = this.recordPageIngest(page.url(), normalized);
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
    args: { readonly fullPage?: boolean | undefined; readonly path?: string | undefined } = {},
  ): Promise<Record<string, unknown>> {
    const { sessionId, pageId, page } = await this.target(target);
    assertCaptureAllowed(this.cardGuard, sessionId, pageId);
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
    // not either, but the browser engine KNOWS it just created this exact
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
    args: { readonly url?: string | undefined; readonly launch?: BrowserLaunchOptions | undefined } = {},
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
    this.cardGuard?.disarm(sessionId, args.pageId);
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
   * `sendBeacon` and friends, a denylist standing between attacker-influenced
   * text and arbitrary code execution, which is a losing shape. An expression
   * built as `globalThis[atob('ZmV0Y2g=')]` defeats a string match while doing
   * exactly what the match existed to stop.
   *
   * So there is no longer any way to express code here. The caller supplies a
   * CSS selector or a ref and names the fields it wants; the function that runs
   * in the page is fixed, ships in this file, and reads DOM properties. A
   * network call is not something this contract can describe, not something we
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
      readonly ref?: string | undefined;
      readonly selector?: string | undefined;
      readonly fields?: readonly BrowserExtractField[] | undefined;
      readonly all?: boolean | undefined;
      readonly limit?: number | undefined;
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

    // Extracted field values are page-written text exactly as body text is,
    // a value lifted out of a form or a table is as good an injection carrier
    // as a paragraph, and recording the origin without the words would leave
    // the derivation check with nothing to compare against.
    // Scrubbed as one serialized blob, which covers every field the caller
    // asked for at once: `value` is the obvious one, and `html` and
    // `attributes` are the ones a page uses when it wants the number to come
    // back out somewhere nobody thought to check.
    const payload = this.scrub(sessionId, pageId, JSON.stringify(extracted));
    const origin = this.recordPageIngest(page.url(), payload);
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
        text: payload,
      }),
    };
  }

  async shutdown(): Promise<void> {
    await this.sessions.shutdown();
  }
}

export { BrowserSessionError, StaleElementError };
