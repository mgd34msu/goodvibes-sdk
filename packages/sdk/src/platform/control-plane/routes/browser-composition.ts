/**
 * routes/browser-composition.ts — the daemon's own browser.
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
 * `getProcessUntrustedContentLedger()` — the same ledger the daemon's mail
 * verbs write to. That is the whole point: reading a page through
 * `browser.readText` and then calling `email.send` in the same turn is ONE
 * composition, and only a shared ledger can see both halves. A fresh ledger
 * here would make the composition invisible while looking correct.
 *
 * The engine is built on FIRST USE, not at registration. Registering the verbs
 * must never resolve a driver, download a browser, or start a process — a
 * daemon that never browses should never have paid for browsing. Everything
 * after that is the engine's: provisioning on demand, sessions addressed by
 * id, and the ownership rule that a browser this daemon did not start has no
 * code path that ends it.
 *
 * Returns `null` when the composition is too narrow to have a home directory,
 * so the verbs stay unregistered rather than half-wired.
 */
import {
  BrowserEngine,
  BrowserSessionManager,
  browserProfileRoot,
  browserScreenshotRoot,
} from '../../browser/index.js';
import type { UntrustedContentPort } from '../../browser/index.js';
import { createUntrustedContentPort } from '../../security/untrusted-content.js';
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
   * Test seam: the untrusted-content port the engine records into. Absent —
   * the daemon's own case — the port is bound to the process-wide ledger the
   * mail verbs also write to.
   */
  readonly browserUntrusted?: UntrustedContentPort | undefined;
}

/** The gateway slice plus the teardown the daemon's disposal scope runs. */
export interface DaemonBrowserGatewayService extends BrowserGatewayService {
  /**
   * Closes browsers this daemon launched. Attached browsers are untouched —
   * the session registry's shutdown only ends what it started.
   */
  shutdown(): Promise<void>;
}

export function createDaemonBrowserGatewayService(
  deps: BrowserCompositionDeps,
): DaemonBrowserGatewayService | null {
  if (deps.browserGateway) return deps.browserGateway;
  const homeDirectory = deps.homeDirectory;
  if (homeDirectory === undefined) return null;

  // Built once, on the first verb that needs it. The promise itself is the
  // single-flight guard: two concurrent verbs share one engine rather than
  // racing to launch two browsers.
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
      },
    ))();
    return pending;
  };

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
    async shutdown() {
      // Never builds an engine in order to tear one down: a daemon that never
      // browsed has nothing to close, and constructing one here would resolve
      // a driver during shutdown.
      if (!pending) return;
      await (await pending).shutdown();
    },
  };
}
