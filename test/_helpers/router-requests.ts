/**
 * Build a JSON request for daemon/router unit tests.
 *
 * The helper intentionally accepts any JSON-serializable body shape so each
 * test can keep its route-specific input type local to the assertion.
 */
export function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
