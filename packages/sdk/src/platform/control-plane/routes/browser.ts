/**
 * routes/browser.ts — the daemon actually serving `browser.*`.
 *
 * The engine became platform capability when it was hoisted into the SDK, and
 * the daemon could link it from that moment. It still could not USE it: no
 * `browser.*` verb existed in the operator contract and no `/api/browser` path
 * was routed anywhere, so a caller with no surface process attached — a
 * schedule, a trigger, an inbound channel message — had nothing to invoke. A
 * capability the daemon can link but cannot call is a capability the operator
 * has to open a surface for.
 *
 * This module is the thin part, exactly as routes/calendar.ts and routes/email.ts
 * are: it maps the descriptors' declared input and output shapes onto a narrow
 * service slice and nothing else. It performs no I/O, opens no browser, and
 * imports nothing from `platform/browser` — the engine arrives through
 * `BrowserGatewayService`, so a test serves every verb from a fake with no
 * driver, no display and no process, and the daemon composition
 * (routes/browser-composition.ts) is the only place that knows the engine
 * exists.
 *
 * Four properties of the engine are preserved here by NOT re-deciding them:
 *
 *  - **A browser the daemon did not start is never closed.** Ownership is
 *    recorded in the session registry at connect time and `closeSession`
 *    refuses an attached session there. This module does not second-guess it,
 *    and `browser.sessions.release` is offered as the honest alternative.
 *  - **`timeoutMs` bounds one call, never the browser.** Every timeout in the
 *    schema is forwarded to the engine as a per-operation deadline. Nothing
 *    here installs a request-scoped timer that closes a session, which would
 *    be the "unrelated timeout killed the browser" defect rebuilt at the HTTP
 *    layer.
 *  - **`extract` cannot express code.** The caller names fields from a fixed
 *    set; unknown names are dropped rather than interpreted, and the function
 *    that runs in the page ships in the engine.
 *  - **Untrusted page content cannot cause an outward effect.** The engine
 *    refuses form submission once the turn has read page content, and the
 *    refusal reaches the caller as a 403 carrying its own fix rather than
 *    being flattened into a 500.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** Which session and page a page-scoped verb acts on. Both default to the open one. */
export interface BrowserGatewayTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
}

/** Launch arguments carried on an ordinary call, so an implicit open matches the ask. */
export interface BrowserGatewayLaunchArgs {
  readonly profileName?: string | undefined;
  readonly headless?: boolean | undefined;
}

/** Every verb answers with an open record; the descriptors declare the shape. */
export type BrowserGatewayResult = Record<string, unknown>;

/** The extraction contract's field set. Nothing here can invoke anything. */
export type BrowserGatewayExtractField = 'text' | 'html' | 'value' | 'attributes';

const EXTRACT_FIELDS: readonly BrowserGatewayExtractField[] = ['text', 'html', 'value', 'attributes'];
const WAIT_UNTIL_STATES = new Set(['load', 'domcontentloaded', 'networkidle']);
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle']);
const SCROLL_DIRECTIONS = new Set(['up', 'down']);

/**
 * What a browser backend must be able to do to serve these verbs.
 *
 * Deliberately the whole engine surface rather than a convenient subset: a
 * daemon that can navigate but cannot select an option, press a key, or move
 * back is a daemon an operator still has to open a surface for.
 */
export interface BrowserGatewayService {
  status(): Promise<BrowserGatewayResult>;
  provision(options: { readonly repair?: boolean | undefined; readonly allowDownload?: boolean | undefined }): Promise<BrowserGatewayResult>;
  listSessions(): Promise<BrowserGatewayResult>;
  launch(options: BrowserGatewayLaunchArgs): Promise<BrowserGatewayResult>;
  attach(options: { readonly cdpEndpoint: string }): Promise<BrowserGatewayResult>;
  release(sessionId: string): Promise<BrowserGatewayResult>;
  close(sessionId: string): Promise<BrowserGatewayResult>;
  navigate(target: BrowserGatewayTarget, args: {
    readonly url: string;
    readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | undefined;
    readonly timeoutMs?: number | undefined;
    readonly launch?: BrowserGatewayLaunchArgs | undefined;
  }): Promise<BrowserGatewayResult>;
  snapshot(target: BrowserGatewayTarget, args: { readonly limit?: number | undefined }): Promise<BrowserGatewayResult>;
  click(target: BrowserGatewayTarget, args: {
    readonly ref: string;
    readonly button?: 'left' | 'right' | 'middle' | undefined;
    readonly clickCount?: number | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  type(target: BrowserGatewayTarget, args: {
    readonly ref: string;
    readonly text: string;
    readonly submit?: boolean | undefined;
    readonly replace?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  select(target: BrowserGatewayTarget, args: {
    readonly ref: string;
    readonly values: readonly string[];
    readonly timeoutMs?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  press(target: BrowserGatewayTarget, args: {
    readonly ref: string;
    readonly key: string;
    readonly timeoutMs?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  scroll(target: BrowserGatewayTarget, args: {
    readonly ref?: string | undefined;
    readonly direction?: 'up' | 'down' | undefined;
    readonly amount?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  waitFor(target: BrowserGatewayTarget, args: {
    readonly text?: string | undefined;
    readonly url?: string | undefined;
    readonly timeoutMs?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  readText(target: BrowserGatewayTarget, args: { readonly maxChars?: number | undefined }): Promise<BrowserGatewayResult>;
  extract(target: BrowserGatewayTarget, args: {
    readonly ref?: string | undefined;
    readonly selector?: string | undefined;
    readonly fields?: readonly BrowserGatewayExtractField[] | undefined;
    readonly all?: boolean | undefined;
    readonly limit?: number | undefined;
  }): Promise<BrowserGatewayResult>;
  screenshot(target: BrowserGatewayTarget, args: {
    readonly fullPage?: boolean | undefined;
    readonly path?: string | undefined;
  }): Promise<BrowserGatewayResult>;
  tabs(target: BrowserGatewayTarget): Promise<BrowserGatewayResult>;
  newTab(target: BrowserGatewayTarget, args: {
    readonly url?: string | undefined;
    readonly launch?: BrowserGatewayLaunchArgs | undefined;
  }): Promise<BrowserGatewayResult>;
  switchTab(target: BrowserGatewayTarget, args: { readonly pageId: string }): Promise<BrowserGatewayResult>;
  closeTab(target: BrowserGatewayTarget, args: { readonly pageId: string }): Promise<BrowserGatewayResult>;
  goBack(target: BrowserGatewayTarget): Promise<BrowserGatewayResult>;
  goForward(target: BrowserGatewayTarget): Promise<BrowserGatewayResult>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const read = readOptionalString(value);
  if (read === undefined) {
    throw new GatewayVerbError(`${field} (non-empty string) is required`, 'INVALID_ARGUMENT', 400);
  }
  return read;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return parsed;
}

/**
 * Booleans arrive as real booleans over the invoke body and as strings over a
 * query string, and "false" is truthy as a string. Reading both spellings here
 * is what keeps `GET /api/browser/status?...`-style callers from silently
 * turning an opt-out into an opt-in.
 */
function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readStringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  const single = readOptionalString(value);
  return single === undefined ? [] : [single];
}

/** Unknown field names are dropped, never interpreted. */
function readExtractFields(value: unknown): readonly BrowserGatewayExtractField[] {
  const requested = new Set(readStringList(value));
  return EXTRACT_FIELDS.filter((field) => requested.has(field));
}

function readTarget(params: Record<string, unknown>): BrowserGatewayTarget {
  return {
    sessionId: readOptionalString(params.sessionId),
    pageId: readOptionalString(params.pageId),
  };
}

function readLaunchArgs(params: Record<string, unknown>): BrowserGatewayLaunchArgs {
  return {
    profileName: readOptionalString(params.profileName),
    headless: readOptionalBoolean(params.headless),
  };
}

/**
 * Turns an engine failure into an honest status.
 *
 * Matched on the error's own name rather than by importing the classes, which
 * is what keeps this module free of `platform/browser`. Each class carries a
 * `fix` naming the next step, and it survives into the message: "no browser
 * session is open" plus "call browser.sessions.launch" is actionable where a
 * bare 500 is not.
 */
function translate(error: unknown): never {
  if (error instanceof GatewayVerbError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const fix = typeof (error as { fix?: unknown }).fix === 'string' ? (error as { fix: string }).fix : null;
  const detail = fix ? `${message} ${fix}` : message;
  const name = error instanceof Error ? error.name : '';
  if (name === 'UntrustedEffectError') {
    // The outward-effect boundary, not a server fault: this turn read content
    // written by whoever controls a page, and acting outwards is exactly the
    // step that content could be trying to cause.
    throw new GatewayVerbError(detail, 'UNTRUSTED_CONTENT_BLOCKED_EFFECT', 403);
  }
  if (name === 'StaleElementError') {
    // The page moved under a ref. Re-snapshotting is the fix, and a conflict
    // says that more honestly than a 400 about the argument, which was valid.
    throw new GatewayVerbError(detail, 'BROWSER_ELEMENT_STALE', 409);
  }
  if (name === 'BrowserSessionError') {
    throw new GatewayVerbError(detail, 'BROWSER_REQUEST_REFUSED', 400);
  }
  throw new GatewayVerbError(detail, 'BROWSER_REQUEST_FAILED', 502);
}

async function guard(run: () => Promise<BrowserGatewayResult>): Promise<BrowserGatewayResult> {
  try {
    return await run();
  } catch (error) {
    return translate(error);
  }
}

/** Every handler reads params the same way and reports failure the same way. */
function handler(
  run: (params: Record<string, unknown>) => Promise<BrowserGatewayResult>,
): GatewayMethodHandler {
  return async (invocation) => guard(async () => run(readInvocationParams(invocation)));
}

export function createBrowserGatewayHandlers(
  service: BrowserGatewayService,
): ReadonlyMap<string, GatewayMethodHandler> {
  const entries: readonly (readonly [string, GatewayMethodHandler])[] = [
    ['browser.status', handler(async () => service.status())],
    ['browser.provision', handler(async (params) => service.provision({
      ...(readOptionalBoolean(params.repair) === undefined ? {} : { repair: readOptionalBoolean(params.repair) }),
      ...(readOptionalBoolean(params.allowDownload) === undefined ? {} : { allowDownload: readOptionalBoolean(params.allowDownload) }),
    }))],
    ['browser.sessions.list', handler(async () => service.listSessions())],
    ['browser.sessions.launch', handler(async (params) => service.launch(readLaunchArgs(params)))],
    ['browser.sessions.attach', handler(async (params) => service.attach({
      cdpEndpoint: readRequiredString(params.cdpEndpoint, 'cdpEndpoint'),
    }))],
    ['browser.sessions.release', handler(async (params) => service.release(readRequiredString(params.sessionId, 'sessionId')))],
    ['browser.sessions.close', handler(async (params) => service.close(readRequiredString(params.sessionId, 'sessionId')))],
    ['browser.navigate', handler(async (params) => {
      const waitUntil = readOptionalString(params.waitUntil);
      return service.navigate(readTarget(params), {
        url: readRequiredString(params.url, 'url'),
        launch: readLaunchArgs(params),
        ...(waitUntil !== undefined && WAIT_UNTIL_STATES.has(waitUntil)
          ? { waitUntil: waitUntil as 'load' | 'domcontentloaded' | 'networkidle' }
          : {}),
        timeoutMs: readOptionalNumber(params.timeoutMs),
      });
    })],
    ['browser.snapshot', handler(async (params) => service.snapshot(readTarget(params), {
      limit: readOptionalNumber(params.limit),
    }))],
    ['browser.click', handler(async (params) => {
      const button = readOptionalString(params.button);
      return service.click(readTarget(params), {
        ref: readRequiredString(params.ref, 'ref'),
        ...(button !== undefined && MOUSE_BUTTONS.has(button) ? { button: button as 'left' | 'right' | 'middle' } : {}),
        clickCount: readOptionalNumber(params.clickCount),
        timeoutMs: readOptionalNumber(params.timeoutMs),
      });
    })],
    ['browser.type', handler(async (params) => service.type(readTarget(params), {
      ref: readRequiredString(params.ref, 'ref'),
      // An empty string is a legitimate value here: clearing a field is
      // `text: ""` with the default replace behaviour, so this one is read
      // without the non-empty requirement the other strings carry.
      text: typeof params.text === 'string' ? params.text : '',
      submit: readOptionalBoolean(params.submit),
      replace: readOptionalBoolean(params.replace),
      timeoutMs: readOptionalNumber(params.timeoutMs),
    }))],
    ['browser.select', handler(async (params) => {
      const values = readStringList(params.values);
      if (values.length === 0) {
        throw new GatewayVerbError('values (a non-empty list of option values) is required', 'INVALID_ARGUMENT', 400);
      }
      return service.select(readTarget(params), {
        ref: readRequiredString(params.ref, 'ref'),
        values,
        timeoutMs: readOptionalNumber(params.timeoutMs),
      });
    })],
    ['browser.press', handler(async (params) => service.press(readTarget(params), {
      ref: readRequiredString(params.ref, 'ref'),
      key: readRequiredString(params.key, 'key'),
      timeoutMs: readOptionalNumber(params.timeoutMs),
    }))],
    ['browser.scroll', handler(async (params) => {
      const direction = readOptionalString(params.direction);
      return service.scroll(readTarget(params), {
        ref: readOptionalString(params.ref),
        ...(direction !== undefined && SCROLL_DIRECTIONS.has(direction) ? { direction: direction as 'up' | 'down' } : {}),
        amount: readOptionalNumber(params.amount),
      });
    })],
    ['browser.waitFor', handler(async (params) => service.waitFor(readTarget(params), {
      text: readOptionalString(params.text),
      url: readOptionalString(params.url),
      timeoutMs: readOptionalNumber(params.timeoutMs),
    }))],
    ['browser.readText', handler(async (params) => service.readText(readTarget(params), {
      maxChars: readOptionalNumber(params.maxChars),
    }))],
    ['browser.extract', handler(async (params) => {
      const fields = readExtractFields(params.fields);
      return service.extract(readTarget(params), {
        ref: readOptionalString(params.ref),
        selector: readOptionalString(params.selector),
        ...(fields.length > 0 ? { fields } : {}),
        all: readOptionalBoolean(params.all),
        limit: readOptionalNumber(params.limit),
      });
    })],
    ['browser.screenshot', handler(async (params) => service.screenshot(readTarget(params), {
      fullPage: readOptionalBoolean(params.fullPage),
      path: readOptionalString(params.path),
    }))],
    ['browser.tabs.list', handler(async (params) => service.tabs(readTarget(params)))],
    ['browser.tabs.create', handler(async (params) => service.newTab(readTarget(params), {
      url: readOptionalString(params.url),
      launch: readLaunchArgs(params),
    }))],
    ['browser.tabs.switch', handler(async (params) => service.switchTab(readTarget(params), {
      pageId: readRequiredString(params.pageId, 'pageId'),
    }))],
    ['browser.tabs.close', handler(async (params) => service.closeTab(readTarget(params), {
      pageId: readRequiredString(params.pageId, 'pageId'),
    }))],
    ['browser.history.back', handler(async (params) => service.goBack(readTarget(params)))],
    ['browser.history.forward', handler(async (params) => service.goForward(readTarget(params)))],
  ];
  return new Map(entries);
}

/** Attach the browser handlers to their registered descriptors (missing = no-op). */
export function registerBrowserGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: BrowserGatewayService,
): void {
  for (const [id, methodHandler] of createBrowserGatewayHandlers(service)) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, methodHandler, { replace: true });
  }
}
