/**
 * Shared contracts for the Google (Gmail + Calendar) setup flows.
 *
 * Two paths exist, and they are genuinely different products:
 *
 *   Path A ("app-password") — no Google Cloud project at all. Gmail is reached
 *   over IMAP/SMTP with a Google app password; Calendar is reached read-only
 *   over the private iCal address. This is the fast lane and the default.
 *
 *   Path B ("oauth") — a Google Cloud project, the Gmail API and Calendar API,
 *   and an OAuth Desktop client. Needed for calendar writes, push/watch
 *   channels and richer queries.
 *
 * Everything in this module is pure data and interfaces. All I/O arrives
 * through injected ports so the flows are testable without a browser, a
 * network, or a Google account.
 */

/** Which of the two setup paths a step belongs to. */
export type GoogleSetupPath = 'app-password' | 'oauth';

/**
 * Who performs a step.
 *
 * - `automated`      — the flow does it with no human involvement.
 * - `human-assisted` — the flow drives the browser to the exact place and the
 *                      human performs one specific interaction (a click, a
 *                      sign-in, a 2FA approval). The flow names the control.
 * - `manual`         — the flow cannot drive it at all; the runbook is the
 *                      only route. Kept explicit so it is never mistaken for
 *                      something the automation silently skipped.
 */
export type GoogleStepActor = 'automated' | 'human-assisted' | 'manual';

/** Terminal states a single step can end in. */
export type GoogleStepOutcome =
  /** The step did its work in this run. */
  | 'done'
  /** Already true before this run started; nothing was changed. */
  | 'already-done'
  /** Waiting on the human. Not an error — the flow reports and stops cleanly. */
  | 'needs-human'
  /** The step failed. `problem` and `fix` are always populated. */
  | 'failed'
  /** Deliberately not run (a prior step it depends on did not complete). */
  | 'skipped';

/**
 * A step definition. This is the source of truth: the executor reads it to
 * know what to run, and the runbook generator reads the same records to emit
 * the written fallback. They cannot drift because there is one list.
 */
export interface GoogleSetupStepSpec {
  readonly id: GoogleStepId;
  readonly path: GoogleSetupPath;
  /** Imperative one-liner shown as live progress: "Creating the app password". */
  readonly title: string;
  /** Why this step exists, in plain language. Shown in the runbook. */
  readonly purpose: string;
  readonly actor: GoogleStepActor;
  /**
   * Numbered manual instructions for the runbook and for error messages when
   * automation fails. Written so they can be followed with no tooling at all.
   */
  readonly manualSteps: readonly string[];
  /** Page the human lands on, when the step involves one. */
  readonly url?: string;
  /**
   * Steps that must have completed first. Used to skip cleanly rather than
   * fail confusingly.
   */
  readonly requires?: readonly GoogleStepId[];
}

/** Stable identifiers for every step in both paths. */
export type GoogleStepId =
  // ---- Path A: app password ----
  | 'browser-ready'
  | 'google-signed-in'
  | 'two-step-verification'
  | 'app-password'
  | 'gmail-config'
  | 'gmail-verify'
  | 'calendar-ics-address'
  | 'calendar-verify'
  // ---- Path B: OAuth ----
  | 'gcloud-installed'
  | 'gcloud-authenticated'
  | 'gcloud-project'
  | 'apis-enabled'
  | 'oauth-branding'
  | 'oauth-audience-production'
  | 'oauth-client'
  | 'oauth-authorize'
  | 'oauth-verify';

/** Result of executing one step. */
export interface GoogleStepResult {
  readonly id: GoogleStepId;
  readonly outcome: GoogleStepOutcome;
  /** Human-readable statement of what actually happened. Never a secret. */
  readonly detail: string;
  /** Populated when outcome is 'failed' or 'needs-human'. */
  readonly problem?: string;
  /** What the human should do next. Populated whenever problem is. */
  readonly fix?: string;
  /**
   * Set when the step could not be completed and the written runbook is the
   * fallback — carries the anchor to jump to.
   */
  readonly runbookAnchor?: string;
  readonly elapsedMs: number;
}

/** Overall result of a flow run. */
export interface GoogleSetupReport {
  readonly path: GoogleSetupPath;
  readonly ok: boolean;
  readonly steps: readonly GoogleStepResult[];
  /**
   * Populated when the run stopped because a human must act. The flow is
   * resumable: re-running after the human acts picks up here.
   */
  readonly waitingOn: GoogleStepId | null;
  /**
   * Plain-language warnings that do not fail the run but that the owner must
   * see — most importantly the 7-day refresh token expiry when an OAuth app is
   * left in Testing.
   */
  readonly warnings: readonly string[];
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Ports (injected I/O)
// ---------------------------------------------------------------------------

/** One interactive element from a page snapshot. */
export interface GoogleBrowserElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly value?: string | undefined;
}

/**
 * The browser surface the Google flows need. Deliberately much smaller than
 * the full browser tool so the flows can be exercised against a fake.
 */
export interface GoogleBrowserPort {
  navigate(url: string): Promise<{ readonly url: string; readonly title: string }>;
  currentUrl(): Promise<string>;
  snapshot(): Promise<readonly GoogleBrowserElement[]>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, options?: { readonly submit?: boolean }): Promise<void>;
  readText(options?: { readonly maxChars?: number }): Promise<string>;
}

/** Outcome of running a subprocess. */
export interface GoogleCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

/** Subprocess execution, injected so gcloud work is testable. */
export interface GoogleCommandPort {
  run(
    command: string,
    args: readonly string[],
    options?: { readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> },
  ): Promise<GoogleCommandResult>;
}

/** Config read/write restricted to what the Google flows touch. */
export interface GoogleConfigPort {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Encrypted secret storage. Values never leave this boundary. */
export interface GoogleSecretPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/**
 * Progress reporting. Every step start and finish is announced, so a run is
 * never a silent grind. Implementations render to the CLI, the TUI feed, or a
 * test buffer.
 */
export interface GoogleProgressPort {
  /** A step is starting. */
  stepStarted(spec: GoogleSetupStepSpec, index: number, total: number): void;
  /** A step finished, with its outcome. */
  stepFinished(spec: GoogleSetupStepSpec, result: GoogleStepResult): void;
  /**
   * The flow needs the human to do something before it can continue. Carries
   * the exact control to interact with.
   */
  humanActionNeeded(spec: GoogleSetupStepSpec, instruction: string): void;
  /** Free-form note. */
  note(message: string): void;
}
