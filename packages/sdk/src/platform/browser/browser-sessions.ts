import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { BrowserHostClient, remoteContext, type BrowserHostOptions } from './browser-host-client.js';
import { createBrowserProvisionIo, loadDriverModule } from './browser-provision-io.js';
import { ensureBrowserBinary } from './browser-provisioning.js';
import type {
  BrowserPageInfo,
  BrowserProvisionIo,
  BrowserProvisionReport,
  BrowserSessionInfo,
  BrowserSessionOrigin,
} from './browser-types.js';

/**
 * Chromium flags that stop the profile from advertising itself as
 * remote-controlled. Sites that refuse to sign in inside an automated browser
 * key off exactly these signals; a persistent profile is useless if the user
 * cannot complete a login in it once.
 */
const STEALTH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--no-first-run',
];

/** Default flags Playwright adds that mark the browser as automated. */
const SUPPRESSED_DEFAULT_ARGS: readonly string[] = ['--enable-automation'];

export interface BrowserLaunchOptions {
  readonly profileName?: string;
  readonly headless?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

export interface BrowserAttachOptions {
  /** A CDP endpoint of a browser the user already has running. */
  readonly cdpEndpoint: string;
}

export class BrowserSessionError extends Error {
  constructor(message: string, readonly fix: string | null = null) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

interface TrackedPage {
  readonly pageId: string;
  readonly page: Page;
}

interface TrackedSession {
  readonly sessionId: string;
  readonly origin: BrowserSessionOrigin;
  readonly context: BrowserContext;
  readonly browser: Browser | null;
  readonly profileDirectory: string | null;
  readonly cdpEndpoint: string | null;
  readonly executablePath: string | null;
  readonly source: BrowserProvisionReport['source'];
  readonly headless: boolean;
  readonly startedAt: string;
  readonly pages: Map<string, TrackedPage>;
  activePageId: string | null;
  pageCounter: number;
}

/**
 * Where saved browser profiles live under a home directory the caller owns.
 *
 * The surface root is the product's own segment under `~/.goodvibes/`, passed
 * in rather than hardcoded, so two surfaces sharing a machine never share a
 * profile directory.
 */
export function browserProfileRoot(homeDirectory: string, surfaceRoot: string): string {
  return resolveSurfaceDirectory(homeDirectory, surfaceRoot, 'browser', 'profiles');
}

/**
 * Where screenshots go: the platform's surface-scoped storage root, alongside
 * profiles. Not a visible folder in someone's project — a surface's own files
 * belong in that surface's own place, and session write provenance is what lets
 * it read them back.
 */
export function browserScreenshotRoot(homeDirectory: string, surfaceRoot: string): string {
  return resolveSurfaceDirectory(homeDirectory, surfaceRoot, 'browser', 'screenshots');
}

function profileDirectoryFor(profileRoot: string, profileName: string): string {
  const safe = profileName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'default';
  return join(profileRoot, safe);
}

interface DriverApi {
  readonly chromium: {
    readonly launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<BrowserContext>;
    readonly connectOverCDP: (endpoint: string, options?: Record<string, unknown>) => Promise<Browser>;
  };
}

function describeLaunchFailure(message: string, profileDirectory: string): BrowserSessionError {
  if (/ProcessSingleton|SingletonLock|profile appears to be in use|Failed to create a ProcessSingleton/i.test(message)) {
    return new BrowserSessionError(
      `The browser profile at ${profileDirectory} is already open in another browser window.`,
      'Attach to the running browser with action:"attach", or launch with a different profileName.',
    );
  }
  if (/Missing X server|no display|cannot open display/i.test(message)) {
    return new BrowserSessionError(
      'This machine has no graphical display, so a visible browser window cannot be opened.',
      'Call action:"launch" with headless:true, which needs no display.',
    );
  }
  if (/error while loading shared libraries|cannot open shared object file/i.test(message)) {
    return new BrowserSessionError(
      `The browser could not start because a system library is missing: ${message.split('\n')[0]}`,
      'Install the browser system dependencies (Debian/Ubuntu: apt-get install libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2; Arch: pacman -S nss atk at-spi2-atk gtk3 alsa-lib).',
    );
  }
  return new BrowserSessionError(`The browser failed to start: ${message.split('\n')[0]}`, null);
}

export interface BrowserSessionManagerDeps {
  /** Directory that holds saved browser profiles. Owned by the composition root. */
  readonly profileRoot: string;
  /**
   * The product's storage root segment under `~/.goodvibes/`, used for the
   * managed driver directory. Required rather than defaulted: a driver this
   * process installs has to land in a directory a named surface owns.
   */
  readonly surfaceRoot: string;
  readonly io?: BrowserProvisionIo;
  /** Loads the Playwright driver. Injected so ownership rules are testable offline. */
  readonly loadDriver?: () => DriverApi | null;
  /** Finds which candidate endpoint has a browser behind it. */
  readonly probeEndpoint?: (candidates: readonly string[]) => Promise<ReachableCdpEndpoint | null>;
  /** Home directory owning the managed browser cache. Defaults to the profile root's owner. */
  readonly homeDirectory?: string;
  /** Where the node-hosted browser host lives, for a build that stages it itself. */
  readonly host?: BrowserHostOptions;
}

/**
 * Owns every live browser connection.
 *
 * The safety rule this class exists to enforce structurally: a browser the
 * agent did not start has no code path that ends it. `closeSession` refuses
 * attached sessions outright, and shutdown only closes what this manager
 * launched. Ownership is recorded at connect time, not decided later.
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, TrackedSession>();
  /** Node-hosted driver processes, one per session that needed one. */
  private readonly hosts = new Map<string, BrowserHostClient>();
  private sessionCounter = 0;
  private lastProvision: BrowserProvisionReport | null = null;
  private readonly io: BrowserProvisionIo;
  private readonly profileRoot: string;
  private readonly homeDirectory: string;
  private readonly loadDriver: () => DriverApi | null;
  private readonly probeEndpoint: (candidates: readonly string[]) => Promise<ReachableCdpEndpoint | null>;
  private readonly hostOptions: BrowserHostOptions;

  constructor(deps: BrowserSessionManagerDeps) {
    this.profileRoot = deps.profileRoot;
    this.homeDirectory = deps.homeDirectory ?? deps.profileRoot;
    this.hostOptions = deps.host ?? {};
    this.io = deps.io ?? createBrowserProvisionIo({
      homeDirectory: this.homeDirectory,
      surfaceRoot: deps.surfaceRoot,
    });
    // The driver may live beside the executable or in this surface's own
    // storage under this home, which is why the loader is told both.
    this.loadDriver = deps.loadDriver
      ?? (() => loadDriverModule({ surfaceRoot: deps.surfaceRoot, homeDirectory: this.homeDirectory }) as DriverApi | null);
    this.probeEndpoint = deps.probeEndpoint ?? firstReachableCdpEndpoint;
  }

  /** Install-kind-aware remediation, from the same injected IO the policy uses. */
  private driverFix(): string {
    return this.io.driverFix?.() ?? 'Install the browser driver beside the executable, or install bun or npm so it can be installed automatically.';
  }

  provisionReport(): BrowserProvisionReport | null {
    return this.lastProvision;
  }

  async provision(options: { readonly repair?: boolean; readonly allowDownload?: boolean } = {}): Promise<BrowserProvisionReport> {
    const report = await ensureBrowserBinary(this.io, {
      forceReinstall: options.repair === true,
      ...(options.allowDownload === undefined ? {} : { allowDownload: options.allowDownload }),
    });
    this.lastProvision = report;
    return report;
  }

  private driver(): DriverApi {
    const driver = this.loadDriver();
    if (!driver) {
      throw new BrowserSessionError(
        'The browser driver is not present and could not be installed automatically.',
        this.driverFix(),
      );
    }
    return driver;
  }

  async launch(options: BrowserLaunchOptions = {}): Promise<BrowserSessionInfo> {
    const provision = await this.provision();
    if (!provision.ok || !provision.executablePath) {
      throw new BrowserSessionError(provision.problem ?? 'No usable browser is available.', provision.fix);
    }
    const profileDirectory = profileDirectoryFor(this.profileRoot, options.profileName ?? 'default');
    mkdirSync(profileDirectory, { recursive: true });
    const headless = options.headless ?? !hasDisplay();
    const driver = this.driver();
    let context: BrowserContext;
    try {
      context = await driver.chromium.launchPersistentContext(profileDirectory, {
        headless,
        executablePath: provision.executablePath,
        args: [...STEALTH_ARGS],
        ignoreDefaultArgs: [...SUPPRESSED_DEFAULT_ARGS],
        viewport: options.viewport ?? { width: 1280, height: 900 },
      });
    } catch (error) {
      throw describeLaunchFailure(error instanceof Error ? error.message : String(error), profileDirectory);
    }
    return this.register({
      origin: 'launched',
      context,
      browser: null,
      profileDirectory,
      cdpEndpoint: null,
      executablePath: provision.executablePath,
      source: provision.source,
      headless,
    });
  }

  /**
   * Connects to a browser the user already has running. The returned session is
   * permanently marked attached, which is what makes closing it impossible.
   */
  async attach(options: BrowserAttachOptions): Promise<BrowserSessionInfo> {
    const driver = this.driver();
    const candidates = cdpEndpointCandidates(options.cdpEndpoint);
    const reachable = await this.probeEndpoint(candidates);
    if (!reachable) {
      throw new BrowserSessionError(
        `No browser is listening at ${options.cdpEndpoint} (tried ${candidates.join(', ')}).`,
        'Start the browser with a remote debugging port (chromium --remote-debugging-port=9222 --user-data-dir=<profile>) and pass that port, or use action:"launch" to have the agent start its own browser with a saved profile.',
      );
    }
    let browser: Browser | null = null;
    let lastMessage = '';
    try {
      // The endpoint is already known to answer, so a long connect timeout only
      // delays an honest answer.
      browser = await driver.chromium.connectOverCDP(reachable.endpoint, { timeout: 8_000 });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
    if (!browser) {
      // This runtime cannot complete a CDP WebSocket handshake, so the
      // connection is made by a Node process instead and driven over a pipe.
      // The result is the same session, with the same operations.
      const hosted = await this.attachThroughHost(reachable.endpoint).catch((error: unknown) => {
        lastMessage = `${lastMessage} | host: ${error instanceof Error ? error.message : String(error)}`;
        return null;
      });
      if (hosted) return hosted;
    }
    if (!browser) {
      // The browser answered on HTTP, so the endpoint is right and the browser
      // is alive. Distinguish "this runtime cannot complete the debugger
      // handshake" from a genuine connection problem, because the two have
      // completely different answers and only one of them is the user's doing.
      const handshake = await cdpWebSocketHandshakeWorks(reachable.webSocketDebuggerUrl);
      throw new BrowserSessionError(
        handshake
          ? `The browser at ${reachable.endpoint} is running and reachable, but this build cannot complete the debugger handshake: ${lastMessage.split('\n')[0]}`
          : `Could not connect to the browser at ${reachable.endpoint}: ${lastMessage.split('\n')[0]}`,
        handshake
          ? 'Use action:"launch" with a profileName instead. The agent opens its own browser with a saved profile, and a sign-in done there persists across runs.'
          : 'Restart the browser with --remote-debugging-port and try again, or use action:"launch".',
      );
    }
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      throw new BrowserSessionError(
        `The browser at ${options.cdpEndpoint} exposed no browsing context to attach to.`,
        'Open a tab in that browser and attach again.',
      );
    }
    return this.register({
      origin: 'attached',
      context,
      browser,
      profileDirectory: null,
      cdpEndpoint: options.cdpEndpoint,
      executablePath: null,
      source: null,
      headless: false,
    });
  }

  /**
   * Attaches by way of the Node-hosted driver.
   *
   * Used when the in-process client cannot complete the handshake. The session
   * it produces is an ordinary attached session: origin 'attached', so nothing
   * here can close the user's browser.
   */
  private async attachThroughHost(endpoint: string): Promise<BrowserSessionInfo | null> {
    const client = new BrowserHostClient(this.hostOptions);
    await client.start();
    const attached = await client.call<{ pages: { pages: { pageId: string; url: string }[] } }>('attach', { endpoint });
    const pages = attached.pages.pages;
    if (pages.length === 0) {
      const created = await client.call<{ pageId: string }>('newPage');
      pages.push({ pageId: created.pageId, url: 'about:blank' });
    }
    const context = remoteContext(client, pages);
    const info = this.register({
      origin: 'attached',
      context,
      browser: null,
      profileDirectory: null,
      cdpEndpoint: endpoint,
      executablePath: null,
      source: null,
      headless: false,
    });
    this.hosts.set(info.sessionId, client);
    return info;
  }

  private register(input: {
    readonly origin: BrowserSessionOrigin;
    readonly context: BrowserContext;
    readonly browser: Browser | null;
    readonly profileDirectory: string | null;
    readonly cdpEndpoint: string | null;
    readonly executablePath: string | null;
    readonly source: BrowserProvisionReport['source'];
    readonly headless: boolean;
  }): BrowserSessionInfo {
    this.sessionCounter += 1;
    const sessionId = `b${String(this.sessionCounter)}`;
    const session: TrackedSession = {
      sessionId,
      origin: input.origin,
      context: input.context,
      browser: input.browser,
      profileDirectory: input.profileDirectory,
      cdpEndpoint: input.cdpEndpoint,
      executablePath: input.executablePath,
      source: input.source,
      headless: input.headless,
      startedAt: new Date().toISOString(),
      pages: new Map(),
      activePageId: null,
      pageCounter: 0,
    };
    this.sessions.set(sessionId, session);
    for (const page of input.context.pages()) this.trackPage(session, page);
    input.context.on('page', (page: Page) => {
      this.trackPage(session, page);
    });
    return this.describe(session);
  }

  private trackPage(session: TrackedSession, page: Page): void {
    session.pageCounter += 1;
    const pageId = `${session.sessionId}p${String(session.pageCounter)}`;
    session.pages.set(pageId, { pageId, page });
    session.activePageId ??= pageId;
    page.on('close', () => {
      session.pages.delete(pageId);
      if (session.activePageId === pageId) {
        session.activePageId = session.pages.keys().next().value ?? null;
      }
    });
  }

  private describe(session: TrackedSession): BrowserSessionInfo {
    return {
      sessionId: session.sessionId,
      origin: session.origin,
      profileDirectory: session.profileDirectory,
      cdpEndpoint: session.cdpEndpoint,
      executablePath: session.executablePath,
      source: session.source,
      headless: session.headless,
      startedAt: session.startedAt,
      pageCount: session.pages.size,
      activePageId: session.activePageId,
      closableByAgent: session.origin === 'launched',
    };
  }

  list(): readonly BrowserSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  info(sessionId: string): BrowserSessionInfo {
    return this.describe(this.require(sessionId));
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  /** The session a call should act on when none is named. */
  defaultSessionId(): string | null {
    const first = this.sessions.keys().next();
    return first.done === true ? null : first.value;
  }

  private require(sessionId: string): TrackedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new BrowserSessionError(
        `No browser session named ${sessionId}.`,
        'Call the browser tool with action:"launch" to start one, or action:"status" to list the live sessions.',
      );
    }
    return session;
  }

  requireContext(sessionId: string): BrowserContext {
    return this.require(sessionId).context;
  }

  async page(sessionId: string, pageId?: string): Promise<{ readonly pageId: string; readonly page: Page }> {
    const session = this.require(sessionId);
    if (pageId) {
      const tracked = session.pages.get(pageId);
      if (!tracked) {
        throw new BrowserSessionError(
          `Session ${sessionId} has no page ${pageId}.`,
          'Call action:"tabs" to list the pages this session controls.',
        );
      }
      return { pageId: tracked.pageId, page: tracked.page };
    }
    if (session.activePageId) {
      const tracked = session.pages.get(session.activePageId);
      if (tracked) return { pageId: tracked.pageId, page: tracked.page };
    }
    const created = await session.context.newPage();
    const before = new Set(session.pages.keys());
    const added = [...session.pages.values()].find((tracked) => !before.has(tracked.pageId) || tracked.page === created);
    if (added) return { pageId: added.pageId, page: added.page };
    this.trackPage(session, created);
    const newest = [...session.pages.values()].pop();
    if (!newest) throw new BrowserSessionError('The browser did not return a usable page.', null);
    return { pageId: newest.pageId, page: newest.page };
  }

  async newPage(sessionId: string): Promise<{ readonly pageId: string; readonly page: Page }> {
    const session = this.require(sessionId);
    const page = await session.context.newPage();
    const tracked = [...session.pages.values()].find((entry) => entry.page === page);
    if (tracked) {
      session.activePageId = tracked.pageId;
      return tracked;
    }
    this.trackPage(session, page);
    const registered = [...session.pages.values()].find((entry) => entry.page === page);
    if (!registered) throw new BrowserSessionError('The browser did not return a usable page.', null);
    session.activePageId = registered.pageId;
    return registered;
  }

  setActivePage(sessionId: string, pageId: string): void {
    const session = this.require(sessionId);
    if (!session.pages.has(pageId)) {
      throw new BrowserSessionError(
        `Session ${sessionId} has no page ${pageId}.`,
        'Call action:"tabs" to list the pages this session controls.',
      );
    }
    session.activePageId = pageId;
  }

  async pageList(sessionId: string): Promise<readonly BrowserPageInfo[]> {
    const session = this.require(sessionId);
    const infos: BrowserPageInfo[] = [];
    for (const tracked of session.pages.values()) {
      let title = '';
      try {
        title = await tracked.page.title();
      } catch {
        title = '';
      }
      infos.push({
        pageId: tracked.pageId,
        url: tracked.page.url(),
        title,
        active: tracked.pageId === session.activePageId,
      });
    }
    return infos;
  }

  /**
   * Ends a browser this agent started. Attached browsers are refused: the agent
   * has no path to end a session a person is using. Closing a TAB inside an
   * attached browser is a separate, page-scoped action.
   */
  async closeSession(sessionId: string): Promise<BrowserSessionInfo> {
    const session = this.require(sessionId);
    if (session.origin === 'attached') {
      throw new BrowserSessionError(
        `Session ${sessionId} is an attached browser that this agent did not start, so it cannot be closed from here.`,
        'Use action:"release" to disconnect from it and leave the browser running, or close the browser yourself.',
      );
    }
    const info = this.describe(session);
    this.sessions.delete(sessionId);
    await session.context.close();
    return info;
  }

  /**
   * Disconnects from a session without ending the browser. For attached
   * browsers this is the ONLY exit: the CDP transport is dropped and the
   * user's browser keeps running with its tabs and login intact.
   */
  release(sessionId: string): BrowserSessionInfo {
    const session = this.require(sessionId);
    const info = this.describe(session);
    this.sessions.delete(sessionId);
    const host = this.hosts.get(sessionId);
    if (host) {
      // Ends the helper process, never the browser it was talking to.
      host.stop();
      this.hosts.delete(sessionId);
    }
    if (session.browser) {
      // Detach the transport without issuing any browser-level close.
      void Promise.resolve()
        .then(async () => {
          const connection = session.browser as unknown as { readonly _connection?: { close?: () => void } };
          connection._connection?.close?.();
        })
        .catch(() => undefined);
    }
    return info;
  }

  /** Closes only what this agent launched. Attached browsers are left running. */
  async shutdown(): Promise<void> {
    for (const [sessionId, host] of this.hosts) {
      host.stop();
      this.hosts.delete(sessionId);
    }
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.sessionId);
      if (session.origin !== 'launched') continue;
      try {
        await session.context.close();
      } catch {
        // A browser that already exited is not an error during shutdown.
      }
    }
  }
}

/**
 * Endpoints to try for an attach, in order.
 *
 * A browser started with --remote-debugging-port may end up listening on IPv6
 * loopback only, in which case connecting to 127.0.0.1 hangs until it times
 * out. Accepting a bare port number and trying both loopback families turns a
 * confusing 30-second stall into a connection that just works.
 */
export function cdpEndpointCandidates(endpoint: string): readonly string[] {
  const trimmed = endpoint.trim();
  const bare = /^\d+$/.test(trimmed) ? trimmed : null;
  if (bare) return [`http://127.0.0.1:${bare}`, `http://[::1]:${bare}`];
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return [trimmed];
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    return [trimmed];
  }
  const port = parsed.port || '9222';
  const host = parsed.hostname;
  const alternates = host === '127.0.0.1' || host === 'localhost'
    ? [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]
    : host === '::1'
      ? [`http://[::1]:${port}`, `http://127.0.0.1:${port}`]
      : [parsed.origin];
  return [...new Set([parsed.origin, ...alternates])];
}

export interface ReachableCdpEndpoint {
  readonly endpoint: string;
  readonly webSocketDebuggerUrl: string | null;
}

/** Finds which candidate endpoint actually has a browser behind it. */
async function firstReachableCdpEndpoint(candidates: readonly string[]): Promise<ReachableCdpEndpoint | null> {
  for (const candidate of candidates) {
    if (candidate.startsWith('ws://') || candidate.startsWith('wss://')) {
      return { endpoint: candidate, webSocketDebuggerUrl: candidate };
    }
    try {
      const response = await fetch(`${candidate.replace(/\/$/, '')}/json/version`, {
        signal: AbortSignal.timeout(2_500),
      });
      if (!response.ok) continue;
      const payload = await response.json() as { readonly webSocketDebuggerUrl?: unknown };
      return {
        endpoint: candidate,
        webSocketDebuggerUrl: typeof payload.webSocketDebuggerUrl === 'string' ? payload.webSocketDebuggerUrl : null,
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Whether a plain WebSocket can complete the debugger handshake this runtime's
 * HTTP client could not. When this succeeds and the driver still failed, the
 * browser is fine and the limitation is ours — which is what the caller is
 * told, instead of a message implying they set something up wrong.
 */
async function cdpWebSocketHandshakeWorks(webSocketDebuggerUrl: string | null): Promise<boolean> {
  if (!webSocketDebuggerUrl) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean, socket?: WebSocket): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.close();
      } catch {
        // Closing a socket that never opened is not an error.
      }
      resolve(value);
    };
    try {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.onopen = () => {
        finish(true, socket);
      };
      socket.onerror = () => {
        finish(false, socket);
      };
      setTimeout(() => {
        finish(false, socket);
      }, 3_000);
    } catch {
      resolve(false);
    }
  });
}

export function hasDisplay(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim());
}
