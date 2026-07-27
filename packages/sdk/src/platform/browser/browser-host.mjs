#!/usr/bin/env node
/**
 * The browser host: a Node process that owns Playwright connections this
 * runtime cannot make itself.
 *
 * Attaching to a browser the user already has open requires a CDP WebSocket
 * handshake. Bun's node:http client does not raise the upgrade event for a 101
 * response, so Playwright's WebSocket client waits forever and every attach
 * times out — while the identical code works under Node. Attaching is not
 * optional: it is the path that works when a site refuses an automated browser,
 * which is the case that started this work.
 *
 * So the connection lives here, in Node, and the agent drives it over plain
 * newline-delimited JSON on stdin/stdout. No WebSocket between the two, because
 * that is the thing that does not work.
 *
 * The protocol is deliberately small. Every operation is addressed by page id,
 * a chain of iframe selectors, and a CSS selector, so there are no object
 * handles to leak or invalidate.
 */
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const state = {
  browser: null,
  context: null,
  pages: new Map(),
  pageCounter: 0,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function trackPage(page) {
  for (const [id, tracked] of state.pages) {
    if (tracked === page) return id;
  }
  state.pageCounter += 1;
  const id = `hp${state.pageCounter}`;
  state.pages.set(id, page);
  page.on('close', () => state.pages.delete(id));
  return id;
}

function requirePage(pageId) {
  const page = pageId ? state.pages.get(pageId) : [...state.pages.values()][0];
  if (!page) throw new Error(`no page ${pageId ?? '(default)'}`);
  return page;
}

/** Narrows a page to the frame addressed by a chain of iframe selectors. */
function scopeFor(page, frameChain) {
  let scope = page;
  for (const selector of frameChain ?? []) {
    scope = scope.frameLocator(selector);
  }
  return scope;
}

function compileFunction(source) {
  // The agent sends the source of a function it wants evaluated in the page.
  // It is this process's own code, shipped in the same package.
  return new Function(`return (${source});`)();
}

const handlers = {
  async attach({ endpoint }) {
    const { chromium } = require('playwright-core');
    state.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const contexts = state.browser.contexts();
    state.context = contexts[0] ?? null;
    if (!state.context) throw new Error('the browser exposed no browsing context');
    for (const page of state.context.pages()) trackPage(page);
    state.context.on('page', (page) => trackPage(page));
    return { pages: await handlers.pages({}) };
  },

  async pages() {
    const pages = [];
    for (const [id, page] of state.pages) {
      pages.push({ pageId: id, url: page.url(), title: await page.title().catch(() => '') });
    }
    return { pages };
  },

  async newPage() {
    if (!state.context) throw new Error('not attached');
    const page = await state.context.newPage();
    return { pageId: trackPage(page) };
  },

  async closePage({ pageId }) {
    await requirePage(pageId).close();
    return { closed: pageId };
  },

  async pageCall({ pageId, method, args }) {
    const page = requirePage(pageId);
    switch (method) {
      case 'url': return { value: page.url() };
      case 'title': return { value: await page.title().catch(() => '') };
      case 'goto': {
        const response = await page.goto(args.url, { waitUntil: args.waitUntil ?? 'domcontentloaded', timeout: args.timeout ?? 30_000 });
        return { value: response ? { status: response.status() } : null };
      }
      case 'goBack': {
        const response = await page.goBack({ timeout: args.timeout ?? 30_000 });
        return { value: response !== null };
      }
      case 'goForward': {
        const response = await page.goForward({ timeout: args.timeout ?? 30_000 });
        return { value: response !== null };
      }
      case 'waitForLoadState':
        await page.waitForLoadState(args.state ?? 'domcontentloaded', { timeout: args.timeout ?? 15_000 }).catch(() => undefined);
        return { value: null };
      case 'waitForURL':
        await page.waitForURL(args.url, { timeout: args.timeout ?? 30_000 });
        return { value: page.url() };
      case 'waitForText':
        await page.getByText(args.text, { exact: false }).first().waitFor({ state: 'visible', timeout: args.timeout ?? 30_000 });
        return { value: true };
      case 'screenshot': {
        const buffer = await page.screenshot({ path: args.path, fullPage: args.fullPage === true });
        return { value: { bytes: buffer.byteLength } };
      }
      case 'wheel':
        await page.mouse.wheel(0, args.delta ?? 0);
        return { value: null };
      default:
        throw new Error(`unknown page method ${method}`);
    }
  },

  /** Every frame in a page, each with the chain of iframe selectors reaching it. */
  async frames({ pageId }) {
    const page = requirePage(pageId);
    const selectorOfFrameElement = compileFunction(FRAME_SELECTOR_SOURCE);
    const frames = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) {
        frames.push({ chain: [], url: frame.url(), main: true });
        continue;
      }
      const chain = [];
      let current = frame;
      let addressable = true;
      while (current && current.parentFrame()) {
        const element = await current.frameElement().catch(() => null);
        if (!element) { addressable = false; break; }
        const selector = await element.evaluate(selectorOfFrameElement).catch(() => '');
        if (!selector) { addressable = false; break; }
        chain.unshift(selector);
        current = current.parentFrame();
      }
      if (addressable) frames.push({ chain, url: frame.url(), main: false });
    }
    return { frames };
  },

  async evaluate({ pageId, frameChain, source, arg }) {
    const page = requirePage(pageId);
    const fn = compileFunction(source);
    if (!frameChain || frameChain.length === 0) {
      return { value: await page.evaluate(fn, arg) };
    }
    // Frame-scoped evaluation resolves the frame by walking the chain.
    let frame = page.mainFrame();
    for (const selector of frameChain) {
      const handle = await scopeForFrames(page, frame, selector);
      if (!handle) throw new Error(`frame ${selector} not found`);
      frame = handle;
    }
    return { value: await frame.evaluate(fn, arg) };
  },

  async locator({ pageId, frameChain, selector, method, args }) {
    const page = requirePage(pageId);
    const scope = scopeFor(page, frameChain);
    const locator = scope.locator(selector);
    // Index-addressed like every other operation here: the caller says which
    // match it means, so nothing depends on remote state between calls.
    const first = typeof args?.index === 'number' ? locator.nth(args.index) : locator.first();
    const timeout = args?.timeout ?? 15_000;
    switch (method) {
      case 'count': return { value: await locator.count() };
      case 'describe': return { value: await first.evaluate(compileFunction(args.source), args.arg) };
      case 'click':
        await first.click({ button: args.button ?? 'left', clickCount: args.clickCount ?? 1, timeout });
        return { value: null };
      case 'fill':
        await first.fill(args.text ?? '', { timeout });
        return { value: null };
      case 'typeSequentially':
        await first.click({ timeout });
        await first.pressSequentially(args.text ?? '', { timeout });
        return { value: null };
      case 'press':
        await first.press(args.key, { timeout });
        return { value: null };
      case 'selectOption':
        return { value: await first.selectOption(args.values ?? [], { timeout }) };
      case 'scrollIntoView':
        await first.scrollIntoViewIfNeeded({ timeout });
        return { value: null };
      default:
        throw new Error(`unknown locator method ${method}`);
    }
  },

  /**
   * Drops the connection without ending the browser.
   *
   * A browser this process attached to belongs to whoever opened it. Nothing
   * here closes it — the transport goes away and the browser keeps running.
   */
  async release() {
    state.browser = null;
    state.context = null;
    state.pages.clear();
    return { released: true };
  },
};

/** Resolves a child frame of `frame` matching an iframe selector. */
async function scopeForFrames(page, frame, selector) {
  const element = await frame.$(selector).catch(() => null);
  if (!element) return null;
  return element.contentFrame();
}

const FRAME_SELECTOR_SOURCE = `function (element) {
  if (element.id) return '#' + element.id.replace(/[^\\w-]/g, '\\\\$&');
  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && current !== document.documentElement) {
    const parent = current.parentElement;
    if (!parent) break;
    const tag = current.tagName.toLowerCase();
    const siblings = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === current.tagName; });
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
    current = parent;
  }
  return parts.join(' > ');
}`;

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const handler = handlers[message.command];
  if (!handler) {
    send({ id: message.id, ok: false, error: `unknown command ${message.command}` });
    return;
  }
  Promise.resolve()
    .then(() => handler(message.params ?? {}))
    .then((result) => send({ id: message.id, ok: true, result }))
    .catch((error) => send({ id: message.id, ok: false, error: error?.message ?? String(error) }));
});

/**
 * This host only works under real Node.
 *
 * Bun places a `node` shim on PATH that re-executes Bun, so spawning "node"
 * can quietly land back in the runtime whose WebSocket upgrade handling is the
 * reason this process exists. Saying so immediately turns a mystifying timeout
 * into an answerable message.
 */
if (process.versions.bun) {
  send({
    id: 0,
    ok: false,
    error: 'the browser host was started under Bun, which cannot complete the debugger handshake it exists to perform',
  });
  process.exit(1);
}

send({ id: 0, ok: true, result: { ready: true, pid: process.pid } });
