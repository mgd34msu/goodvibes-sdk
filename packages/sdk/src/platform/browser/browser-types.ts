/**
 * Shared types for first-class browser automation.
 *
 * The engine under platform/browser/ is deliberately free of product-surface
 * imports (no command context, no tool registry, no renderer). Every external
 * effect it needs — spawning a process, touching the filesystem, loading the
 * Playwright driver, recording untrusted content — arrives through an injected
 * record, so the same engine serves the agent, the daemon, and any other
 * surface without carrying one product's wiring or being untestable offline.
 */

/** Where a usable browser binary came from. */
export type BrowserBinarySource =
  /** Already present in the managed Playwright browser cache. */
  | 'managed-cache'
  /** Downloaded into the managed cache by this provisioning act. */
  | 'managed-download'
  /** A browser already installed on the machine (Chrome/Chromium/Edge/Brave). */
  | 'system-browser';

/**
 * Every distinct way provisioning can fail on a clean machine. Each value maps
 * to a plain-language problem statement AND a named fix, because "browser not
 * available" with no next step is what made this capability unusable before.
 */
export type BrowserProvisionFailure =
  | 'driver-missing'
  /**
   * No driver is present and this call was told to install nothing, so none was
   * attempted. Distinct from 'driver-missing' on purpose: that value means
   * installing WAS tried and could not finish, and reporting it for a call that
   * never tried would tell the owner their machine cannot get a driver when in
   * fact nothing has asked for one yet. Only a reporting call (status, or any
   * provision with allowDownload:false) can produce this.
   */
  | 'driver-not-installed-yet'
  | 'download-failed'
  | 'download-blocked-offline'
  | 'binary-missing-after-install'
  | 'binary-not-executable'
  | 'missing-system-libraries'
  | 'cache-directory-unwritable'
  | 'unknown';

export interface BrowserProvisionStep {
  readonly step: string;
  readonly detail: string;
  readonly ok: boolean;
  readonly elapsedMs: number;
}

export interface BrowserProvisionReport {
  readonly ok: boolean;
  readonly source: BrowserBinarySource | null;
  readonly executablePath: string | null;
  readonly browsersPath: string;
  readonly driverVersion: string | null;
  /** Honest progress: what provisioning actually did, in order, with timings. */
  readonly steps: readonly BrowserProvisionStep[];
  readonly failure: BrowserProvisionFailure | null;
  /** Plain-language statement of what is wrong. Null when ok. */
  readonly problem: string | null;
  /** Exactly what to do about it. Null when ok. */
  readonly fix: string | null;
}

export interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

/** Resolution of the Playwright driver package itself (not the browser binary). */
export interface BrowserDriverResolution {
  readonly available: boolean;
  readonly packageDirectory: string | null;
  readonly cliPath: string | null;
  readonly version: string | null;
  readonly error: string | null;
}

/** Injected IO for provisioning, so tests never download or spawn anything. */
export interface BrowserProvisionIo {
  readonly resolveDriver: () => BrowserDriverResolution;
  /** Installs the driver package into a directory this surface owns. */
  readonly installDriver?: (targetRoot: string) => Promise<CommandOutcome>;
  /** Where a self-installed driver goes. */
  readonly managedDriverRoot?: () => string;
  /**
   * What to tell the user when the driver is neither present nor installable,
   * phrased for how this build was installed. Injected so the provisioning
   * policy never has to know about release assets or package managers.
   */
  readonly driverFix?: () => string;
  readonly expectedExecutablePath: () => string | null;
  readonly browsersPath: () => string;
  readonly pathExists: (path: string) => boolean;
  readonly isExecutableFile: (path: string) => boolean;
  readonly directoryWritable: (path: string) => boolean;
  readonly removePath: (path: string) => void;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> },
  ) => Promise<CommandOutcome>;
  readonly systemBrowserCandidates: () => readonly string[];
  readonly now: () => number;
}

/** How a browser session came to exist — the ownership fact the safety rules key on. */
export type BrowserSessionOrigin =
  /** This process started the browser. Only these may ever be closed by it. */
  | 'launched'
  /** The browser was already running. This process connected and must never end it. */
  | 'attached';

export interface BrowserSessionInfo {
  readonly sessionId: string;
  readonly origin: BrowserSessionOrigin;
  readonly profileDirectory: string | null;
  readonly cdpEndpoint: string | null;
  readonly executablePath: string | null;
  readonly source: BrowserBinarySource | null;
  readonly headless: boolean;
  readonly startedAt: string;
  readonly pageCount: number;
  readonly activePageId: string | null;
  /**
   * False for attached sessions. Enforced by the session registry rather than
   * by convention: there is physically no code path that ends a browser this
   * process did not start.
   */
  readonly closableByAgent: boolean;
}

export interface BrowserPageInfo {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

/**
 * One addressable element from a snapshot. `ref` is only meaningful together
 * with the snapshot that produced it: acting on a ref re-verifies the element's
 * identity before touching it, so a stale ref fails loudly instead of clicking
 * whatever now occupies that position.
 */
export interface BrowserElementRef {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly selector: string;
  readonly value?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly checked?: boolean | undefined;
  readonly depth: number;
  /**
   * Activating this control submits a form, which sends data to whoever runs
   * the site. Recorded at snapshot time so the outward-effect boundary is a
   * fact about the element rather than a guess at click time.
   */
  readonly submits: boolean;
  /**
   * Selectors of the iframes this element sits inside, outermost first. Empty
   * for the main document. Embedded forms and consent screens live in frames
   * routinely, so an element inside one has to be addressable like any other.
   */
  readonly frameChain: readonly string[];
}

export interface BrowserSnapshot {
  readonly sessionId: string;
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly snapshotId: string;
  readonly elements: readonly BrowserElementRef[];
  readonly truncated: boolean;
}

/*
 * ── The untrusted-content port ──────────────────────────────────────────────
 *
 * Page text is written by whoever controls the site, and this engine holds the
 * ability to click, submit and type. Both halves of a prompt-injection chain
 * sit in one process, so page content is labelled where it enters and outward
 * effects are refused once a turn has read any.
 *
 * The contract that decides all of that — what counts as untrusted, what an
 * origin is, which surfaces carry command authority, and the running ledger of
 * what has been read this turn — belongs to the PRODUCT, not to this module.
 * It has to, because the same ledger is shared with the email surface: reading
 * a page here and trying to send a message there is one composition, and only a
 * single shared ledger can see both halves.
 *
 * So this module names the four operations it needs and nothing else. The
 * product supplies an implementation bound to its own ledger, its own notion of
 * origin, and its own standing rule.
 */

/**
 * A piece of text labelled with where it came from, as the product's trust
 * contract shapes it. The engine never inspects these fields; it hands the
 * envelope back to its caller so the origin and the rule travel with the text.
 */
export interface UntrustedContentEnvelope {
  readonly trust: 'untrusted';
  readonly surface: string;
  readonly origin: string;
  readonly retrievedAt: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly rule: string;
}

/**
 * An owner approval covering one outward action.
 *
 * Opaque to this module on purpose: only the product can mint one, and only
 * from a surface that carries command authority. Page text cannot manufacture
 * one no matter what it says, because nothing here constructs these.
 */
export interface OwnerApproval {
  readonly action: string;
  readonly grantedAt: string;
  readonly surface: 'owner-direct';
}

export interface OutwardEffectDecision {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly fix: string | null;
  readonly untrustedOrigins: readonly string[];
}

/**
 * The product's untrusted-content contract, narrowed to what browsing needs.
 *
 * An implementation is expected to be bound to the process-wide ledger the
 * email surface also writes to, and to the 'web-page' surface — this module
 * never names a surface, so an implementation cannot be reused for the wrong
 * one by accident.
 */
export interface UntrustedContentPort {
  /** The standing rule shipped alongside every piece of untrusted content. */
  readonly rule: string;
  /** Where content came from, in a form a person can read. */
  readonly originOf: (url: string) => string;
  /** Wraps page text in the product's labelled envelope. */
  readonly label: (input: {
    readonly origin: string;
    readonly text: string;
    readonly truncated?: boolean;
  }) => UntrustedContentEnvelope;
  /** Records that page content entered the conversation, with its origin. */
  readonly recordIngest: (input: { readonly origin: string; readonly at: string }) => void;
  /**
   * Decides whether an action that reaches the outside world may run now,
   * given what this turn has already read and whether the owner asked for it.
   */
  readonly evaluateOutwardEffect: (input: {
    readonly action: string;
    readonly description: string;
    readonly approval: OwnerApproval | null;
  }) => OutwardEffectDecision;
}
