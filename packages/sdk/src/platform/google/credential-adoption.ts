/**
 * Finding Google credentials that already exist on this machine.
 *
 * The defect this exists to fix: working Gmail OAuth credentials were sitting
 * in `~/.gmail-mcp/` while the agent told its owner that email was not
 * configured — because nothing ever looked there. Capability discovery
 * reported empty registries and the model reasoned from that emptiness.
 *
 * So adoption is deliberately generous about where it looks and deliberately
 * strict about what it does with what it finds:
 *
 *   - Adopted files are **read, never written**. They belong to another tool
 *     that is in active use; rotating or rewriting them would break it.
 *   - Secret values never leave this module except through the returned
 *     credential record. Summaries, logs, errors and progress lines carry only
 *     presence, provenance, scopes and expiry — never a token.
 *
 * Precedence is native-first: once the agent has its own credentials in the
 * encrypted store, those win, and the adopted copy becomes a fallback.
 */

/** Where a credential came from. Safe to display. */
export type GoogleCredentialOrigin =
  /** The agent's own encrypted secret store. */
  | 'secret-store'
  /** Adopted read-only from a gmail-mcp installation. */
  | 'gmail-mcp';

/** Minimal file access, injected so adoption is testable without a real home directory. */
export interface GoogleFilePort {
  exists(path: string): boolean;
  readText(path: string): string | null;
}

/** A complete, usable OAuth credential set. Contains secrets — never log this. */
export interface GoogleOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly accessToken: string | null;
  /** Epoch milliseconds when the access token expires, when known. */
  readonly expiresAtMs: number | null;
  readonly scopes: readonly string[];
  readonly tokenUri: string;
  readonly origin: GoogleCredentialOrigin;
  /** Where it was found. A path or a store key name — never a value. */
  readonly location: string;
}

/**
 * The safe-to-display view. Everything in here can go in a log line, a status
 * panel, a transcript or an error message.
 */
export interface GoogleCredentialSummary {
  readonly found: boolean;
  readonly origin: GoogleCredentialOrigin | null;
  readonly location: string | null;
  readonly scopes: readonly string[];
  readonly hasRefreshToken: boolean;
  readonly hasAccessToken: boolean;
  /** True when an access token exists but is past (or within a minute of) expiry. */
  readonly accessTokenExpired: boolean;
  /** Capabilities the granted scopes actually permit. */
  readonly canSendMail: boolean;
  readonly canReadMail: boolean;
  readonly canReadCalendar: boolean;
  readonly canWriteCalendar: boolean;
  readonly detail: string;
}

/** Standard locations a gmail-mcp install keeps its files in. */
export interface GmailMcpLayout {
  readonly clientFile: string;
  readonly tokenFiles: readonly string[];
}

/** Build the gmail-mcp paths under an explicit home directory. */
export function gmailMcpLayout(homeDirectory: string): GmailMcpLayout {
  const root = `${homeDirectory.replace(/\/+$/, '')}/.gmail-mcp`;
  return {
    clientFile: `${root}/gcp-oauth.keys.json`,
    // Two shapes exist in the wild; both are read, newest usable one wins.
    tokenFiles: [`${root}/google-workspace-credentials.json`, `${root}/credentials.json`],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Scope strings can arrive space-delimited or as an array. */
function readScopes(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  const raw = readString(value);
  return raw === null ? [] : raw.split(/\s+/).filter((entry) => entry.length > 0);
}

interface ClientFileContents {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUri: string;
}

/** Read a `gcp-oauth.keys.json`. Handles both `installed` and `web` wrappers. */
function readClientFile(file: GoogleFilePort, path: string): ClientFileContents | null {
  const parsed = parseJson(file.readText(path));
  if (parsed === null) return null;
  const inner = isRecord(parsed.installed)
    ? parsed.installed
    : isRecord(parsed.web)
      ? parsed.web
      : parsed;
  const clientId = readString(inner.client_id);
  const clientSecret = readString(inner.client_secret);
  if (clientId === null || clientSecret === null) return null;
  return {
    clientId,
    clientSecret,
    tokenUri: readString(inner.token_uri) ?? 'https://oauth2.googleapis.com/token',
  };
}

interface TokenFileContents {
  readonly refreshToken: string;
  readonly accessToken: string | null;
  readonly expiresAtMs: number | null;
  readonly scopes: readonly string[];
}

/**
 * Read a token file. The two known shapes differ in how they express expiry:
 * `expiry_date` is an absolute epoch, `expires_in` is a duration from an
 * issue time we do not have. A duration alone cannot be turned into an
 * absolute expiry, so it is treated as unknown rather than guessed — an
 * unknown expiry makes the token manager refresh proactively, which is the
 * safe direction to be wrong in.
 */
function readTokenFile(file: GoogleFilePort, path: string): TokenFileContents | null {
  const parsed = parseJson(file.readText(path));
  if (parsed === null) return null;
  const refreshToken = readString(parsed.refresh_token);
  if (refreshToken === null) return null;

  const expiryDate = parsed.expiry_date;
  const expiresAtMs =
    typeof expiryDate === 'number' && Number.isFinite(expiryDate) && expiryDate > 0 ? expiryDate : null;

  return {
    refreshToken,
    accessToken: readString(parsed.access_token),
    expiresAtMs,
    scopes: readScopes(parsed.scope ?? parsed.requested_scopes),
  };
}

/**
 * Look for an adoptable credential set in a gmail-mcp installation.
 * Returns null when nothing usable is present. Never writes.
 */
export function adoptGmailMcpCredentials(
  file: GoogleFilePort,
  homeDirectory: string,
): GoogleOAuthCredentials | null {
  const layout = gmailMcpLayout(homeDirectory);
  if (!file.exists(layout.clientFile)) return null;

  const client = readClientFile(file, layout.clientFile);
  if (client === null) return null;

  for (const tokenPath of layout.tokenFiles) {
    if (!file.exists(tokenPath)) continue;
    const token = readTokenFile(file, tokenPath);
    if (token === null) continue;
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAtMs: token.expiresAtMs,
      scopes: token.scopes,
      tokenUri: client.tokenUri,
      origin: 'gmail-mcp',
      location: tokenPath,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scope interpretation
// ---------------------------------------------------------------------------

const MAIL_SEND_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

const MAIL_READ_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
]);

const CALENDAR_READ_SCOPES = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.readonly',
]);

const CALENDAR_WRITE_SCOPES = new Set([
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
]);

function grants(scopes: readonly string[], allowed: ReadonlySet<string>): boolean {
  return scopes.some((scope) => allowed.has(scope));
}

/** Treat a token as expired slightly early so a call never races the clock. */
const EXPIRY_SKEW_MS = 60_000;

/** Build the safe-to-display summary. Never includes a secret value. */
export function summarizeCredentials(
  credentials: GoogleOAuthCredentials | null,
  now: number,
): GoogleCredentialSummary {
  if (credentials === null) {
    return {
      found: false,
      origin: null,
      location: null,
      scopes: [],
      hasRefreshToken: false,
      hasAccessToken: false,
      accessTokenExpired: false,
      canSendMail: false,
      canReadMail: false,
      canReadCalendar: false,
      canWriteCalendar: false,
      detail: 'No Google credentials found. Run: /google setup',
    };
  }

  const expired =
    credentials.accessToken !== null &&
    credentials.expiresAtMs !== null &&
    credentials.expiresAtMs - EXPIRY_SKEW_MS <= now;

  const canSendMail = grants(credentials.scopes, MAIL_SEND_SCOPES);
  const canReadMail = grants(credentials.scopes, MAIL_READ_SCOPES);
  const canReadCalendar = grants(credentials.scopes, CALENDAR_READ_SCOPES);
  const canWriteCalendar = grants(credentials.scopes, CALENDAR_WRITE_SCOPES);

  const capabilities = [
    canSendMail ? 'send mail' : null,
    canReadMail ? 'read mail' : null,
    canWriteCalendar ? 'read and write calendar' : canReadCalendar ? 'read calendar' : null,
  ].filter((entry): entry is string => entry !== null);

  const originLabel =
    credentials.origin === 'gmail-mcp'
      ? `adopted from an existing gmail-mcp install at ${credentials.location}`
      : 'from the encrypted secret store';

  return {
    found: true,
    origin: credentials.origin,
    location: credentials.location,
    scopes: credentials.scopes,
    hasRefreshToken: credentials.refreshToken.length > 0,
    hasAccessToken: credentials.accessToken !== null,
    accessTokenExpired: expired,
    canSendMail,
    canReadMail,
    canReadCalendar,
    canWriteCalendar,
    detail:
      capabilities.length > 0
        ? `Google credentials ${originLabel}. Permitted: ${capabilities.join(', ')}.`
        : `Google credentials ${originLabel}, but the granted scopes permit no mail or calendar access.`,
  };
}
