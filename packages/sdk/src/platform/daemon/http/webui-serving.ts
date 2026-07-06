/**
 * webui-serving.ts
 *
 * Two opt-in capabilities that let a browser-hosted web UI reach the daemon:
 *
 *   1. Same-origin bundle serving (PRIMARY). When `controlPlane.webui.serve` is
 *      on, the daemon serves a configured build directory at `/` so the bundle
 *      and the API share an origin — the browser's same-origin policy is then a
 *      non-issue. This is wire-compatible with `tailscale serve`, which fronts
 *      the single daemon origin over HTTPS: bundle + API arrive same-origin.
 *      The bundle is public (served without a token); the app itself
 *      token-authenticates its API calls, so no wire data leaks from serving
 *      static files.
 *
 *   2. Cross-origin request support (SECONDARY). When `controlPlane.cors.enabled`
 *      is on, OPTIONS preflight is answered and Access-Control-Allow-* headers
 *      are emitted ONLY for origins on the explicit `controlPlane.cors.allowedOrigins`
 *      allowlist (the Vite dev server, a deliberately separate origin, etc.).
 *      There is no wildcard: the matched origin is echoed back, credentials are
 *      allowlist-gated, and `Vary: Origin` is always set so caches stay correct.
 *
 * BOTH default OFF. With both off the daemon behaves exactly as before: no bundle
 * is served and no Access-Control-Allow-Origin is ever emitted. The loopback
 * default posture is unchanged; these capabilities are explicit opt-ins, never
 * auto-enabled by network host mode.
 */

import { resolve, sep } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import { readStringList } from '../helpers.js';

/** Resolved, per-request view of the two opt-in serving capabilities. */
export interface WebuiServingPosture {
  /** True when the daemon should serve the configured bundle directory at `/`. */
  readonly serveBundle: boolean;
  /** Absolute or working-dir-relative bundle directory; empty string when unset. */
  readonly bundleDir: string;
  /** Cross-origin request support (OPTIONS preflight + Access-Control-Allow-*). */
  readonly cors: {
    readonly enabled: boolean;
    /** Explicit origin allowlist. Never wildcarded; empty means "refuse every origin". */
    readonly allowedOrigins: readonly string[];
  };
  /** OpenAI-compatible path prefix (reserved so bundle serving never shadows it). */
  readonly openaiPathPrefix: string;
}

function readConfig(configManager: ConfigManager, key: string): unknown {
  const getter = (configManager as { readonly get?: unknown }).get;
  return typeof getter === 'function' ? getter.call(configManager, key) : undefined;
}

/** Read the current serving posture from config. Cheap; called per request. */
export function resolveWebuiServingPosture(configManager: ConfigManager): WebuiServingPosture {
  const serveBundle = readConfig(configManager, 'controlPlane.webui.serve') === true;
  const bundleDirRaw = readConfig(configManager, 'controlPlane.webui.bundleDir');
  const corsEnabled = readConfig(configManager, 'controlPlane.cors.enabled') === true;
  const allowedOrigins = readStringList(readConfig(configManager, 'controlPlane.cors.allowedOrigins')) ?? [];
  const openaiPrefixRaw = readConfig(configManager, 'controlPlane.openaiCompatible.pathPrefix');
  return {
    serveBundle,
    bundleDir: typeof bundleDirRaw === 'string' ? bundleDirRaw.trim() : '',
    cors: { enabled: corsEnabled, allowedOrigins },
    openaiPathPrefix: typeof openaiPrefixRaw === 'string' && openaiPrefixRaw.trim() ? openaiPrefixRaw.trim() : '/v1',
  };
}

// ---------------------------------------------------------------------------
// CORS (secondary path)
// ---------------------------------------------------------------------------

/** Append a token to an existing Vary header without duplicating it. */
function appendVary(existing: string | null, token: string): string {
  if (!existing) return token;
  const parts = existing.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === token.toLowerCase())) return existing;
  return [...parts, token].join(', ');
}

/** True when the origin is on the explicit allowlist (exact match, no wildcard). */
function isOriginAllowed(origin: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(origin);
}

/**
 * Answer a CORS preflight (OPTIONS). Emits Access-Control-Allow-* only for an
 * allowlisted origin; a non-allowlisted origin is refused honestly (403, no
 * Access-Control-Allow-Origin) so the browser preflight fails cleanly.
 */
export function handleCorsPreflight(req: Request, posture: WebuiServingPosture): Response {
  const origin = req.headers.get('origin');
  // A preflight with no Origin is not a browser CORS preflight — answer 204 with
  // no allow-origin (nothing to grant); never emit a wildcard.
  if (origin === null) {
    return new Response(null, { status: 204, headers: { Vary: 'Origin' } });
  }
  if (!isOriginAllowed(origin, posture.cors.allowedOrigins)) {
    return Response.json(
      { error: 'ORIGIN_NOT_ALLOWED', code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not on controlPlane.cors.allowedOrigins.' },
      { status: 403, headers: { Vary: 'Origin' } },
    );
  }
  // Echo the requested headers when present, otherwise a safe default that always
  // includes Authorization so the bearer-token API flow works cross-origin.
  const requestedHeaders = req.headers.get('access-control-request-headers');
  const allowHeaders = requestedHeaders && requestedHeaders.trim()
    ? requestedHeaders
    : 'Authorization, Content-Type';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': allowHeaders,
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/**
 * Decorate an actual (non-preflight) response with CORS headers when the request
 * carries an allowlisted Origin. `Vary: Origin` is always added while CORS is
 * enabled so caches never serve an allow-origin to the wrong origin. A
 * non-allowlisted origin gets Vary but NO Access-Control-Allow-Origin — the
 * browser then blocks the read honestly.
 */
export function applyCorsHeaders(req: Request, response: Response, posture: WebuiServingPosture): Response {
  const origin = req.headers.get('origin');
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  headers.set('Vary', appendVary(headers.get('Vary'), 'Origin'));
  if (isOriginAllowed(origin, posture.cors.allowedOrigins)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ---------------------------------------------------------------------------
// Static bundle serving (primary path)
// ---------------------------------------------------------------------------

/** Extension → content type for the common web-bundle asset kinds. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

function extensionOf(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES[extensionOf(pathname)] ?? 'application/octet-stream';
}

/** True when a path belongs to the daemon API/route surface and must never be
 *  served as a static file (API routes keep precedence). Boundary-aware so a SPA
 *  route like `/tasks` is not mistaken for the daemon's `/task` route. */
function isReservedApiPath(pathname: string, openaiPrefix: string): boolean {
  const reserved = ['/api', '/login', '/webhook', '/task', openaiPrefix];
  return reserved.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** True when the request looks like an SPA navigation (HTML document) rather than
 *  a fetch for a concrete asset — used to decide whether the index.html fallback
 *  applies. A missing concrete asset must 404, not return the HTML shell. */
function isNavigationRequest(req: Request, pathname: string): boolean {
  if (extensionOf(pathname) === '') return true;
  return (req.headers.get('accept') ?? '').includes('text/html');
}

function cacheControlFor(pathname: string, isShell: boolean): string {
  if (isShell || extensionOf(pathname) === 'html') return 'no-cache';
  if (pathname.includes('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

async function fileResponse(
  req: Request,
  file: ReturnType<typeof Bun.file>,
  pathname: string,
  isShell: boolean,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(pathname),
    'Cache-Control': cacheControlFor(pathname, isShell),
  };
  if (req.method === 'HEAD') {
    const size = await file.size;
    return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
  return new Response(file, { status: 200, headers });
}

/**
 * Serve a file from the configured bundle directory, with SPA fallback to
 * index.html for navigation routes. Returns null when serving is disabled, the
 * request is not a GET/HEAD, or the path is a reserved API route — in every
 * "null" case the caller continues with normal daemon routing, so behavior is
 * unchanged when the capability is off. Path traversal outside the bundle
 * directory is refused with 403.
 */
export async function serveWebuiBundle(req: Request, posture: WebuiServingPosture): Promise<Response | null> {
  if (!posture.serveBundle || !posture.bundleDir) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;

  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (pathname.includes('\0')) return new Response('Bad Request', { status: 400 });
  if (isReservedApiPath(pathname, posture.openaiPathPrefix)) return null;

  const root = resolve(posture.bundleDir);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = resolve(root, relative);
  // Reject anything that escapes the bundle root (path traversal).
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  const file = Bun.file(resolved);
  if (await file.exists()) {
    const isShell = resolved === resolve(root, 'index.html');
    // Derive the content type from the resolved file path, not the request path —
    // a `GET /` serves index.html and must answer text/html, not octet-stream.
    return fileResponse(req, file, resolved, isShell);
  }

  // SPA fallback: an unknown navigation route serves the app shell; a missing
  // concrete asset is an honest 404 (never the HTML shell in a JS/CSS request).
  if (isNavigationRequest(req, pathname)) {
    const indexFile = Bun.file(resolve(root, 'index.html'));
    if (await indexFile.exists()) {
      return fileResponse(req, indexFile, '/index.html', true);
    }
  }
  return new Response('Not Found', { status: 404 });
}
