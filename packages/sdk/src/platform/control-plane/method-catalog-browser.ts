import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  JSON_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  listOutputSchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

/**
 * Browser operator methods, real browser control through the standard
 * operator method protocol.
 *
 * These are SERVED. `registerBrowserGatewayMethods`
 * (control-plane/routes/browser.ts) attaches an in-process handler to each id
 * over a `BrowserGatewayService`, the daemon composition supplies the
 * implementation backed by the platform engine (platform/browser), and
 * `GATEWAY_REST_ROUTES` maps each advertised http path to the same handler, so
 * the REST path and the methodId-invoke endpoint resolve identically.
 *
 * They did not used to exist at all. The engine was hoisted into the SDK and
 * the daemon could link it, but no `browser.*` verb and no `/api/browser`
 * route was ever declared, so a daemon-only caller had nothing to invoke: with
 * no surface process attached, scheduled work, triggers and channel-driven
 * work could not open a page, read one, or fill anything in. Hoisting the
 * engine made serving them possible; this catalog is the half that makes them
 * reachable.
 *
 * The verb set deliberately mirrors the whole surface a product's `browser`
 * tool exposes rather than a convenient subset, navigation, snapshots,
 * clicking, typing, selecting, key presses, scrolling, waiting, reading,
 * extraction, screenshots, tabs, history, and the full session lifecycle. A
 * daemon that can do nine of a surface's twenty-three things is still a daemon
 * an operator has to open a surface for.
 *
 * Two properties of the engine survive into this contract rather than being
 * re-decided here:
 *
 *  - **`browser.sessions.close` cannot end a browser the daemon did not
 *    start.** The refusal lives in the session registry, so the descriptor
 *    only has to be honest that close is for launched sessions and
 *    `browser.sessions.release` is how you let go of an attached one.
 *  - **There is no `evaluate`.** `browser.extract` names fields from a fixed
 *    set and runs a function that ships in the engine; nothing in this schema
 *    can express code to run in a page.
 */

const BROWSER_TARGET_PROPERTIES = {
  sessionId: STRING_SCHEMA,
  pageId: STRING_SCHEMA,
} as const;

const BROWSER_SESSION_SCHEMA = objectSchema({
  sessionId: STRING_SCHEMA,
  origin: STRING_SCHEMA,
  profileDirectory: STRING_SCHEMA,
  cdpEndpoint: STRING_SCHEMA,
  executablePath: STRING_SCHEMA,
  source: STRING_SCHEMA,
  headless: BOOLEAN_SCHEMA,
  startedAt: STRING_SCHEMA,
  pageCount: NUMBER_SCHEMA,
  activePageId: STRING_SCHEMA,
  closableByAgent: BOOLEAN_SCHEMA,
}, ['sessionId', 'origin', 'headless', 'startedAt', 'pageCount', 'closableByAgent']);

const BROWSER_PAGE_SCHEMA = objectSchema({
  pageId: STRING_SCHEMA,
  url: STRING_SCHEMA,
  title: STRING_SCHEMA,
  active: BOOLEAN_SCHEMA,
}, ['pageId', 'url', 'title', 'active']);

/**
 * Every page-derived payload is returned inside the product's untrusted
 * envelope, never as a bare string, so the origin and the standing rule travel
 * with the text into whatever reads it next.
 */
const UNTRUSTED_ENVELOPE_SCHEMA = objectSchema({
  trust: STRING_SCHEMA,
  surface: STRING_SCHEMA,
  origin: STRING_SCHEMA,
  retrievedAt: STRING_SCHEMA,
  text: STRING_SCHEMA,
  truncated: BOOLEAN_SCHEMA,
  rule: STRING_SCHEMA,
}, ['trust', 'surface', 'origin', 'retrievedAt', 'text', 'truncated', 'rule']);

const SNAPSHOT_ELEMENT_SCHEMA = objectSchema({
  ref: STRING_SCHEMA,
  role: STRING_SCHEMA,
  name: STRING_SCHEMA,
  value: STRING_SCHEMA,
  disabled: BOOLEAN_SCHEMA,
  checked: BOOLEAN_SCHEMA,
}, ['ref', 'role', 'name']);

/** What every page-scoped verb answers with, before its own additions. */
function pageResultSchema(properties: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
  return objectSchema({
    sessionId: STRING_SCHEMA,
    pageId: STRING_SCHEMA,
    url: STRING_SCHEMA,
    ...properties,
  }, ['sessionId', 'pageId'], { additionalProperties: true });
}

/** A page-scoped input: the target, plus whatever the verb itself needs. */
function pageInputSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: readonly string[] = [],
): Record<string, unknown> {
  return bodyEnvelopeSchema({ ...BROWSER_TARGET_PROPERTIES, ...properties }, required);
}

export const builtinGatewayBrowserMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'browser.status',
    title: 'Browser Status',
    description: 'Report whether a browser is available on this machine, where its binary came from, whether a display exists, and which sessions are open.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'GET', path: '/api/browser/status' },
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({
      browserAvailable: BOOLEAN_SCHEMA,
      binarySource: STRING_SCHEMA,
      executablePath: STRING_SCHEMA,
      driverVersion: STRING_SCHEMA,
      browsersPath: STRING_SCHEMA,
      displayAvailable: BOOLEAN_SCHEMA,
      defaultMode: STRING_SCHEMA,
      sessions: arraySchema(BROWSER_SESSION_SCHEMA),
      provisionSteps: arraySchema(JSON_OBJECT_SCHEMA),
      problem: STRING_SCHEMA,
      fix: STRING_SCHEMA,
    }, ['browserAvailable'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.provision',
    title: 'Provision Browser',
    description: 'Install the browser driver and binary this machine needs, reporting each step it actually ran. Slow on a clean machine; every other verb provisions on demand.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/provision' },
    inputSchema: bodyEnvelopeSchema({
      repair: BOOLEAN_SCHEMA,
      allowDownload: BOOLEAN_SCHEMA,
    }),
    outputSchema: objectSchema({
      provision: JSON_OBJECT_SCHEMA,
    }, ['provision'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.sessions.list',
    title: 'List Browser Sessions',
    description: 'Return every open browser session, including whether the daemon started it and may therefore close it.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'GET', path: '/api/browser/sessions' },
    inputSchema: objectSchema({}),
    outputSchema: listOutputSchema('sessions', BROWSER_SESSION_SCHEMA),
  }),
  methodDescriptor({
    id: 'browser.sessions.launch',
    title: 'Launch Browser Session',
    description: 'Start a browser the daemon owns. Pass a profileName to keep sign-ins across runs; headless defaults to true where no display exists.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/sessions/launch' },
    inputSchema: bodyEnvelopeSchema({
      profileName: STRING_SCHEMA,
      headless: BOOLEAN_SCHEMA,
    }),
    outputSchema: objectSchema({
      session: BROWSER_SESSION_SCHEMA,
      setup: STRING_SCHEMA,
      note: STRING_SCHEMA,
    }, ['session'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.sessions.attach',
    title: 'Attach To Running Browser',
    description: 'Connect to a browser already running at a remote debugging endpoint. The daemon can drive it but can never close it.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/sessions/attach' },
    inputSchema: bodyEnvelopeSchema({
      cdpEndpoint: STRING_SCHEMA,
    }, ['cdpEndpoint']),
    outputSchema: objectSchema({
      session: BROWSER_SESSION_SCHEMA,
      pages: arraySchema(BROWSER_PAGE_SCHEMA),
      note: STRING_SCHEMA,
    }, ['session'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.sessions.release',
    title: 'Release Browser Session',
    description: 'Disconnect from a session and leave the browser running. This is how an attached browser is let go of.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/sessions/release' },
    inputSchema: bodyEnvelopeSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      released: BROWSER_SESSION_SCHEMA,
      note: STRING_SCHEMA,
    }, ['released'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.sessions.close',
    title: 'Close Browser Session',
    description: 'End a browser the daemon started. A session attached to a browser the daemon did not start is refused; release it instead.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/sessions/close' },
    inputSchema: bodyEnvelopeSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: objectSchema({
      closed: BROWSER_SESSION_SCHEMA,
    }, ['closed'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.navigate',
    title: 'Navigate',
    description: 'Load a URL, opening a session first if none is open. http, https, file and about schemes only; a javascript: URL is refused because it runs script against whatever page is already loaded.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/navigate' },
    inputSchema: pageInputSchema({
      url: STRING_SCHEMA,
      waitUntil: STRING_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
      profileName: STRING_SCHEMA,
      headless: BOOLEAN_SCHEMA,
    }, ['url']),
    outputSchema: pageResultSchema({
      title: STRING_SCHEMA,
      httpStatus: NUMBER_SCHEMA,
      setup: STRING_SCHEMA,
      next: STRING_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.snapshot',
    title: 'Snapshot Page',
    description: 'Return addressable element refs for the current page. Element names come from the page, so the result is untrusted content and is labelled as such.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'POST', path: '/api/browser/snapshot' },
    inputSchema: pageInputSchema({ limit: NUMBER_SCHEMA }),
    outputSchema: pageResultSchema({
      title: STRING_SCHEMA,
      contentTrust: STRING_SCHEMA,
      origin: STRING_SCHEMA,
      rule: STRING_SCHEMA,
      snapshotId: STRING_SCHEMA,
      elementCount: NUMBER_SCHEMA,
      truncated: BOOLEAN_SCHEMA,
      elements: arraySchema(SNAPSHOT_ELEMENT_SCHEMA),
    }),
  }),
  methodDescriptor({
    id: 'browser.click',
    title: 'Click Element',
    description: 'Click an element resolved from the latest snapshot of this page. Activating a control that submits a form is an outward effect and is refused when this turn has read untrusted page content.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/click' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      button: STRING_SCHEMA,
      clickCount: NUMBER_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
    }, ['ref']),
    outputSchema: pageResultSchema({
      clicked: JSON_OBJECT_SCHEMA,
      urlBefore: STRING_SCHEMA,
      navigated: BOOLEAN_SCHEMA,
      next: STRING_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.type',
    title: 'Type Into Element',
    description: 'Type into an element resolved from the latest snapshot. There is no variant that types into whatever window has focus. submit:true presses Enter afterwards and is an outward effect.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/type' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      text: STRING_SCHEMA,
      submit: BOOLEAN_SCHEMA,
      replace: BOOLEAN_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
    }, ['ref', 'text']),
    outputSchema: pageResultSchema({
      typedInto: JSON_OBJECT_SCHEMA,
      submitted: BOOLEAN_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.select',
    title: 'Select Options',
    description: 'Choose option values in a select element resolved from the latest snapshot.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/select' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      values: arraySchema(STRING_SCHEMA),
      timeoutMs: NUMBER_SCHEMA,
    }, ['ref', 'values']),
    outputSchema: pageResultSchema({
      selectedIn: JSON_OBJECT_SCHEMA,
      selected: arraySchema(STRING_SCHEMA),
    }),
  }),
  methodDescriptor({
    id: 'browser.press',
    title: 'Press Key',
    description: 'Send one key to an element resolved from the latest snapshot. Enter is treated as a form submission and is an outward effect.',
    category: 'browser',
    scopes: ['write:browser'],
    dangerous: true,
    http: { method: 'POST', path: '/api/browser/press' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      key: STRING_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
    }, ['ref', 'key']),
    outputSchema: pageResultSchema({
      pressed: STRING_SCHEMA,
      on: JSON_OBJECT_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.scroll',
    title: 'Scroll Page',
    description: 'Scroll the page by an amount, or bring a snapshot element into view.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/scroll' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      direction: STRING_SCHEMA,
      amount: NUMBER_SCHEMA,
    }),
    outputSchema: pageResultSchema({
      scrolledBy: NUMBER_SCHEMA,
      scrolledTo: JSON_OBJECT_SCHEMA,
      scrollY: NUMBER_SCHEMA,
      scrollHeight: NUMBER_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.waitFor',
    title: 'Wait For Page State',
    description: 'Wait for text to become visible, for the URL to match, or for the network to settle. The timeout bounds this call only and never ends the browser.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'POST', path: '/api/browser/wait-for' },
    inputSchema: pageInputSchema({
      text: STRING_SCHEMA,
      url: STRING_SCHEMA,
      timeoutMs: NUMBER_SCHEMA,
    }),
    outputSchema: pageResultSchema({
      waitedFor: JSON_OBJECT_SCHEMA,
      found: BOOLEAN_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.readText',
    title: 'Read Page Text',
    description: 'Read the page as text, including open shadow roots and embedded frames, each frame origin recorded separately. Returns the text inside an untrusted-content envelope.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'POST', path: '/api/browser/read-text' },
    inputSchema: pageInputSchema({ maxChars: NUMBER_SCHEMA }),
    outputSchema: pageResultSchema({
      title: STRING_SCHEMA,
      content: UNTRUSTED_ENVELOPE_SCHEMA,
      truncated: BOOLEAN_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.extract',
    title: 'Extract Page Data',
    description: 'Read named fields out of elements matched by a snapshot ref or a CSS selector. The function that runs in the page is fixed and ships in the engine; there is no way to express code here. Password input values are never returned.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'POST', path: '/api/browser/extract' },
    inputSchema: pageInputSchema({
      ref: STRING_SCHEMA,
      selector: STRING_SCHEMA,
      fields: arraySchema(STRING_SCHEMA),
      all: BOOLEAN_SCHEMA,
      limit: NUMBER_SCHEMA,
    }),
    outputSchema: pageResultSchema({
      matched: NUMBER_SCHEMA,
      returned: NUMBER_SCHEMA,
      note: STRING_SCHEMA,
      data: UNTRUSTED_ENVELOPE_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.screenshot',
    title: 'Screenshot Page',
    description: 'Write a PNG of the visible area or the whole scrollable page and report the exact path written.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'POST', path: '/api/browser/screenshot' },
    inputSchema: pageInputSchema({
      fullPage: BOOLEAN_SCHEMA,
      path: STRING_SCHEMA,
    }),
    outputSchema: pageResultSchema({
      path: STRING_SCHEMA,
      bytes: NUMBER_SCHEMA,
      next: STRING_SCHEMA,
    }),
  }),
  methodDescriptor({
    id: 'browser.tabs.list',
    title: 'List Tabs',
    description: 'Return every open page in a session, with which one is active.',
    category: 'browser',
    scopes: ['read:browser'],
    http: { method: 'GET', path: '/api/browser/tabs' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      pages: arraySchema(BROWSER_PAGE_SCHEMA),
    }, ['sessionId', 'pages'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.tabs.create',
    title: 'Open Tab',
    description: 'Open a new tab, optionally at a URL, opening a session first if none is open.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/tabs' },
    inputSchema: pageInputSchema({
      url: STRING_SCHEMA,
      profileName: STRING_SCHEMA,
      headless: BOOLEAN_SCHEMA,
    }),
    outputSchema: pageResultSchema({ pages: arraySchema(BROWSER_PAGE_SCHEMA) }),
  }),
  methodDescriptor({
    id: 'browser.tabs.switch',
    title: 'Switch Tab',
    description: 'Make another open tab the active one for later page verbs.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/tabs/switch' },
    inputSchema: pageInputSchema({}, ['pageId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      activePageId: STRING_SCHEMA,
    }, ['sessionId', 'activePageId'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.tabs.close',
    title: 'Close Tab',
    description: 'Close one tab. The browser itself keeps running.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/tabs/close' },
    inputSchema: pageInputSchema({}, ['pageId']),
    outputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      closedPageId: STRING_SCHEMA,
      pages: arraySchema(BROWSER_PAGE_SCHEMA),
    }, ['sessionId', 'closedPageId', 'pages'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'browser.history.back',
    title: 'Go Back',
    description: 'Move the page back one entry in its history.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/history/back' },
    inputSchema: pageInputSchema(),
    outputSchema: pageResultSchema({ moved: BOOLEAN_SCHEMA }),
  }),
  methodDescriptor({
    id: 'browser.history.forward',
    title: 'Go Forward',
    description: 'Move the page forward one entry in its history.',
    category: 'browser',
    scopes: ['write:browser'],
    http: { method: 'POST', path: '/api/browser/history/forward' },
    inputSchema: pageInputSchema(),
    outputSchema: pageResultSchema({ moved: BOOLEAN_SCHEMA }),
  }),
];
