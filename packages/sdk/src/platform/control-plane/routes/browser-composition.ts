/**
 * routes/browser-composition.ts, the daemon's own browser.
 *
 * Assembling it here rather than in the runtime composition root keeps two
 * properties visible.
 *
 * **The daemon owns its own browser storage.** Profiles and screenshots land
 * under the daemon's surface-scoped root, so a sign-in performed once in a
 * daemon-launched window is still there for the schedule that runs at 3am, and
 * no surface's profile directory is shared or trampled.
 *
 * **The ledger is the process's, not this module's.** The untrusted-content
 * port handed to the engine records into
 * `getProcessUntrustedContentLedger()`, the same ledger the daemon's mail
 * verbs write to. That is the whole point: reading a page through
 * `browser.readText` and then calling `email.send` in the same turn is ONE
 * composition, and only a shared ledger can see both halves. A fresh ledger
 * here would make the composition invisible while looking correct.
 *
 * The engine is built on FIRST USE, not at registration. Registering the verbs
 * must never resolve a driver, download a browser, or start a process, a
 * daemon that never browses should never have paid for browsing. Everything
 * after that is the engine's: provisioning on demand, sessions addressed by
 * id, and the ownership rule that a browser this daemon did not start has no
 * code path that ends it.
 *
 * Returns `null` when the composition is too narrow to have a home directory,
 * so the verbs stay unregistered rather than half-wired.
 *
 * ── The checkout seam ─────────────────────────────────────────────────────
 *
 * `payments.checkout.begin` and `payments.checkout.fillCard` both need a page
 * driver bound to an open page of a browser engine, and that engine has to be
 * THIS one: the model snapshots a checkout through `browser.*`, and a purchase
 * driving a second engine would be typing into a page nobody is looking at.
 * The engine also has to carry the card-material guard the payments service
 * arms, or it scrubs page output against an empty set while a card sits on the
 * form.
 *
 * Both follow from one callback. `onBrowserCheckout` receives a guard this
 * module minted and a driver factory over the engine that guard was built into,
 * bound together in one object. A composition cannot supply a guard, so it
 * cannot supply the wrong one, and if it arms some other redactor anyway the
 * driver refuses to type rather than typing unprotected.
 *
 * The seam also carries `armSubmitApproval`, a composition-only path onto the
 * engine's `setOwnerApproval` (see browser-checkout-driver.ts's header for why
 * this is deliberately not reachable from `platform/payments/`), and the
 * driver factory is built with whatever `describeSubmission` this composition
 * supplies, absent by default, which is what makes an unverified submission
 * the honest default rather than a claimed purchase nothing here confirmed.
 */
import {
  BrowserEngine,
  BrowserSessionManager,
  browserProfileRoot,
  browserScreenshotRoot,
} from '../../browser/index.js';
import type { BrowserEngineOptions, UntrustedContentPort } from '../../browser/index.js';
import { createUntrustedContentPort } from '../../security/untrusted-content.js';
import { CardMaterialRedactor } from '../../payments/card-redaction.js';
import { createBrowserCheckoutDriverFactory } from '../../payments/browser-checkout-driver.js';
import type {
  CheckoutSubmission,
  CheckoutSubmissionDescription,
} from '../../payments/browser-checkout-driver.js';
import type { CheckoutPageDriver } from '../../payments/checkout-page.js';
import type { OwnerApproval } from '../../browser/index.js';
import type { BrowserGatewayService } from './browser.js';

/**
 * The daemon's own segment under `~/.goodvibes/`. The same literal the daemon
 * CLI and boot path pass to every other store it owns; a browser profile is
 * daemon state like any other.
 */
const DAEMON_SURFACE_ROOT = 'goodvibes';

/**
 * What the daemon tells someone whose browser host script is missing. The SDK
 * ships no installer, so the sentence names the daemon's own repair path.
 */
const MISSING_HOST_SCRIPT_FIX =
  'Reinstall the daemon so its files are complete, then retry.';

/** The slice of the verb-group deps this composition needs. */
export interface BrowserCompositionDeps {
  /** Absent in narrow compositions; the browser needs a real storage root. */
  readonly homeDirectory?: string | undefined;
  /** Test seam: overrides the whole service, so no driver or process is touched. */
  readonly browserGateway?: DaemonBrowserGatewayService | undefined;
  /**
   * Test seam: the untrusted-content port the engine records into. Absent,
   * the daemon's own case, the port is bound to the process-wide ledger the
   * mail verbs also write to.
   */
  readonly browserUntrusted?: UntrustedContentPort | undefined;
  /**
   * Receives the checkout seam, once, at composition time.
   *
   * Present: the engine is built WITH a card-material guard this function mints,
   * and the same object is handed back alongside a page-driver factory over that
   * same engine. That is the whole reason the callback exists rather than a
   * `cardFieldGuard` input. A consumer cannot supply a guard, so it cannot supply
   * a different one than the engine holds; the only object that works is the one
   * it is given, and the driver refuses if the payments service ever arms
   * another (see payments/browser-checkout-driver.ts).
   *
   * Absent: no guard is minted and the engine is exactly what it was before,
   * which is what every browser-only composition should get. A browser used for
   * ordinary automation needs no card redaction, and building one with a guard
   * nothing arms would only make `cardFieldGuardInstalled()` lie.
   */
  readonly onBrowserCheckout?: ((seam: BrowserCheckoutSeam) => void) | undefined;
  /**
   * Reads a merchant order id or a verification step off a submitted
   * checkout's landing page.
   *
   * Absent by default, which is honest: reading a merchant's own confirmation
   * page is site-specific knowledge this SDK does not carry. Without it, a
   * submitted purchase is recorded and reported as unverified rather than as
   * an indistinguishable-from-confirmed "purchased", see checkout-flow.ts and
   * browser-checkout-driver.ts's header for what that changes.
   */
  readonly describeSubmission?:
    | ((submission: CheckoutSubmission) => Promise<CheckoutSubmissionDescription>)
    | undefined;
}

/** The gateway slice plus the teardown the daemon's disposal scope runs. */
export interface DaemonBrowserGatewayService extends BrowserGatewayService {
  /**
   * Closes browsers this daemon launched. Attached browsers are untouched,
   * the session registry's shutdown only ends what it started.
   */
  shutdown(): Promise<void>;
}

/**
 * The two halves a checkout needs, minted together so they cannot come apart.
 *
 * `cardFieldGuard` is what `PaymentsGatewayServiceImpl` must be constructed
 * with, and `driverFor` is what its `driverFor` dependency must be. Both are
 * bound to ONE engine, which is the engine the `browser.*` verbs also drive, so
 * a page the model snapshotted is the page the purchase runs on.
 */
export interface BrowserCheckoutSeam {
  /** Hand this to `PaymentsServiceDeps.cardFieldGuard`, unchanged. */
  readonly cardFieldGuard: CardMaterialRedactor;
  /** Hand this to `PaymentsServiceDeps.driverFor`, unchanged. */
  driverFor(sessionId: string, pageId: string): CheckoutPageDriver;
  /**
   * Arms the owner's approval for ONE outward submit, directly on the engine
   * this seam's driver runs against.
   *
   * Composition-only, and deliberately so: this seam is handed to whoever
   * composes the daemon's browser, never to anything in `platform/payments/`,
   * so payments code has no path that could mint its own approval and spend
   * against it. See browser-checkout-driver.ts's header for when the
   * untrusted-effect guard actually needs one, most invocations clear it a
   * different way (the turn-boundary reset), and this exists as the honest
   * fallback for when they do not.
   */
  armSubmitApproval(approval: OwnerApproval | null): Promise<void>;
}

/**
 * The daemon's engine, built once on first use.
 *
 * The promise itself is the single-flight guard: two concurrent verbs share one
 * engine rather than racing to launch two browsers. Returns null when the
 * composition is too narrow to have a home directory.
 */
function daemonEngineFactory(
  deps: BrowserCompositionDeps,
  cardFieldGuard: BrowserEngineOptions['cardFieldGuard'],
): { readonly engineFor: () => Promise<BrowserEngine>; readonly shutdown: () => Promise<void> } | null {
  const homeDirectory = deps.homeDirectory;
  if (homeDirectory === undefined) return null;

  let pending: Promise<BrowserEngine> | null = null;
  const engineFor = async (): Promise<BrowserEngine> => {
    pending ??= (async (): Promise<BrowserEngine> => new BrowserEngine(
      new BrowserSessionManager({
        profileRoot: browserProfileRoot(homeDirectory, DAEMON_SURFACE_ROOT),
        homeDirectory,
        surfaceRoot: DAEMON_SURFACE_ROOT,
        host: { missingScriptFix: MISSING_HOST_SCRIPT_FIX },
      }),
      {
        screenshotDirectory: browserScreenshotRoot(homeDirectory, DAEMON_SURFACE_ROOT),
        untrusted: deps.browserUntrusted ?? createUntrustedContentPort({
          surface: 'web-page',
          toolName: 'browser',
        }),
        ...(cardFieldGuard === undefined ? {} : { cardFieldGuard }),
      },
    ))();
    return pending;
  };

  return {
    engineFor,
    async shutdown() {
      // Never builds an engine in order to tear one down: a daemon that never
      // browsed has nothing to close, and constructing one here would resolve
      // a driver during shutdown.
      if (!pending) return;
      await (await pending).shutdown();
    },
  };
}

/**
 * Compose the daemon browser, and the checkout seam when one was asked for.
 *
 * This is the entry `registerGatewayVerbGroups` calls.
 * `createDaemonBrowserGatewayService` remains the browser-only entry and is
 * unchanged in signature and in behavior; a caller that passes no
 * `onBrowserCheckout` gets exactly the engine it got before.
 */
export function composeDaemonBrowser(
  deps: BrowserCompositionDeps,
): DaemonBrowserGatewayService | null {
  // A supplied gateway is an override of the whole service, so there is no
  // engine here to bind a page driver to. `onBrowserCheckout` asked for a
  // guard bound to THIS composition's own engine, and an overridden gateway
  // has no such engine, so honouring both silently would mean the caller's
  // seam callback simply never fires, with no signal that it was dropped. A
  // caller that wired a checkout seam onto an overridden gateway almost
  // certainly meant to override the checkout seam too (a test double that
  // also drives payments), which this composition cannot do, so it says so
  // rather than composing a gateway with a payments capability quietly
  // missing.
  if (deps.browserGateway && deps.onBrowserCheckout) {
    throw new Error(
      'composeDaemonBrowser was given both browserGateway and onBrowserCheckout: an overridden gateway '
      + 'has no engine of its own to build the checkout seam on, so onBrowserCheckout would never fire. '
      + 'Pass browserGateway alone for a browser-only test double, or drop it and let this composition '
      + 'build its own engine so the checkout seam has something real to bind to.',
    );
  }
  if (deps.browserGateway) return deps.browserGateway;

  const onCheckout = deps.onBrowserCheckout;
  const cardFieldGuard = onCheckout === undefined ? undefined : new CardMaterialRedactor();
  const built = daemonEngineFactory(deps, cardFieldGuard);
  if (built === null) return null;

  if (onCheckout !== undefined && cardFieldGuard !== undefined) {
    onCheckout({
      cardFieldGuard,
      driverFor: createBrowserCheckoutDriverFactory({
        engineFor: built.engineFor,
        cardFieldGuard,
        ...(deps.describeSubmission === undefined ? {} : { describeSubmission: deps.describeSubmission }),
      }),
      armSubmitApproval: async (approval) => {
        (await built.engineFor()).setOwnerApproval(approval);
      },
    });
  }

  return gatewayOverEngine(built.engineFor, built.shutdown);
}

/**
 * The name every pre-existing caller uses. One implementation, so a caller that
 * DID pass `onBrowserCheckout` here cannot silently get a browser with no seam.
 */
export function createDaemonBrowserGatewayService(
  deps: BrowserCompositionDeps,
): DaemonBrowserGatewayService | null {
  return composeDaemonBrowser(deps);
}

function gatewayOverEngine(
  engineFor: () => Promise<BrowserEngine>,
  shutdown: () => Promise<void>,
): DaemonBrowserGatewayService {
  return {
    async status() {
      return (await engineFor()).status();
    },
    async provision(options) {
      return { provision: await (await engineFor()).provision(options) };
    },
    async listSessions() {
      return { sessions: (await engineFor()).sessionManager().list() };
    },
    async launch(options) {
      return (await engineFor()).launch(options);
    },
    async attach(options) {
      return (await engineFor()).attach(options);
    },
    async release(sessionId) {
      return (await engineFor()).release(sessionId);
    },
    async close(sessionId) {
      return (await engineFor()).close(sessionId);
    },
    async navigate(target, args) {
      return (await engineFor()).navigate(target, args);
    },
    async snapshot(target, args) {
      return (await engineFor()).snapshot(target, args);
    },
    async click(target, args) {
      return (await engineFor()).click(target, args);
    },
    async type(target, args) {
      return (await engineFor()).type(target, args);
    },
    async select(target, args) {
      return (await engineFor()).select(target, args);
    },
    async press(target, args) {
      return (await engineFor()).press(target, args);
    },
    async scroll(target, args) {
      return (await engineFor()).scroll(target, args);
    },
    async waitFor(target, args) {
      return (await engineFor()).waitFor(target, args);
    },
    async readText(target, args) {
      return (await engineFor()).readText(target, args);
    },
    async extract(target, args) {
      return (await engineFor()).extract(target, args);
    },
    async screenshot(target, args) {
      return (await engineFor()).screenshot(target, args);
    },
    async tabs(target) {
      return (await engineFor()).tabs(target);
    },
    async newTab(target, args) {
      return (await engineFor()).newTab(target, args);
    },
    async switchTab(target, args) {
      return (await engineFor()).switchTab(target, args);
    },
    async closeTab(target, args) {
      return (await engineFor()).closeTab(target, args);
    },
    async goBack(target) {
      return (await engineFor()).goBack(target);
    },
    async goForward(target) {
      return (await engineFor()).goForward(target);
    },
    shutdown,
  };
}
