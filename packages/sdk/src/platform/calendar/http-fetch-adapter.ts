/**
 * http-fetch-adapter.ts — a pure adapter turning a standard WHATWG `fetch` into the
 * connector's injected HttpFetch boundary. This module references only the global
 * fetch/Response (no node:*), so it stays within the calendar module's purity
 * contract; the actual `fetch` used is supplied by the caller (the agent passes the
 * runtime fetch, tests pass a fake server's fetch).
 */

import type { HttpFetch, HttpRequest, HttpResponse } from './oauth-types.js';

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Wrap a WHATWG-style fetch into an HttpFetch. Defaults to the global fetch. */
export function fetchAdapter(fetchImpl?: FetchLike): HttpFetch {
  const impl: FetchLike = fetchImpl ?? ((globalThis as { fetch: FetchLike }).fetch);
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const res = await impl(req.url, {
      method: req.method,
      ...(req.headers ? { headers: { ...req.headers } } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return {
      status: res.status,
      ok: res.ok,
      header: (name: string) => res.headers.get(name),
      json: () => res.json(),
      text: () => res.text(),
    };
  };
}
