/**
 * wire-verb-availability.ts — the runtime discriminator that lets a memory wire
 * consumer tell "no such record" apart from "this daemon does not serve this verb".
 *
 * THE PROBLEM THIS SOLVES. A newer consumer may talk to an OLDER daemon that never
 * registered an extended memory route (list / update / links / search-semantic /
 * export …). Calling such a route hits the daemon's terminal route-not-found 404.
 * A record-scoped verb (update / link) against a CURRENT daemon can ALSO 404 — when
 * the addressed record genuinely does not exist. Both are HTTP 404, so a consumer
 * that inspects only the status folds BOTH to `null` and then reports an existing
 * record as "not found" against an older daemon — a silent data lie on the exact
 * version-skew path the wire feature advertises as supported.
 *
 * THE RUNTIME SIGNAL. The daemon already distinguishes the two in the response BODY:
 * a genuine record-miss carries `code: MEMORY_RECORD_NOT_FOUND_CODE`
 * (daemon-sdk's memory handlers), while a route-not-found carries the terminal
 * 404's `code: 'NOT_FOUND'`. So the disposition is read from the body code, NOT the
 * transport object's shape:
 *   - 404 + record-missing code           → 'record-missing' (safe to fold to null)
 *   - 404 + any OTHER code, or NO code     → 'method-unavailable' (honest reject)
 *   - anything that is not a 404           → 'other' (propagate unchanged)
 *
 * THE LEGACY-404 RULING. A pre-error-unification daemon may answer a bare 404 with
 * no structured code at all. That 404 is ambiguous — it could be either case — and
 * we deliberately treat it as 'method-unavailable', NOT 'record-missing'. A loud
 * wrong ("this daemon does not serve X" when the record was in fact simply absent)
 * is recoverable and honest; a silent wrong (reporting an existing record as gone)
 * is the exact dishonest-recall failure this whole design exists to prevent. Never
 * silently null on an ambiguous 404.
 */

import { MEMORY_RECORD_NOT_FOUND_CODE } from '@pellux/goodvibes-errors';

/** How a caught wire error should be treated by an extended-verb call site. */
export type MemoryWire404Disposition = 'record-missing' | 'method-unavailable' | 'other';

interface Wire404Signal {
  readonly status: number | undefined;
  readonly code: string | undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBodyCode(body: unknown): string | undefined {
  return body !== null && typeof body === 'object'
    ? readString((body as { code?: unknown }).code)
    : undefined;
}

/**
 * Pull the (status, code) signal out of any of the error shapes the three memory
 * transports actually throw:
 *  - an SDK `HttpStatusError` (TUI transport via `createTransportError`): `.status`
 *    + `.code`, with a `.transport.body.code` fallback;
 *  - an error carrying an explicit `.status`/`.code` (the agent transport stamps
 *    these onto its thrown error) or a `.body.code`;
 *  - a bare `Error` whose message embeds `HTTP <status>` (a legacy/hand-rolled
 *    transport) — status parsed out, code absent.
 */
function extractWire404Signal(error: unknown): Wire404Signal {
  if (error === null || typeof error !== 'object') {
    return { status: undefined, code: undefined };
  }
  const record = error as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly body?: unknown;
    readonly transport?: { readonly status?: unknown; readonly body?: unknown } | undefined;
    readonly message?: unknown;
  };
  const status =
    readNumber(record.status)
    ?? readNumber(record.transport?.status)
    ?? parseStatusFromMessage(record.message);
  const code =
    readString(record.code)
    ?? readBodyCode(record.transport?.body)
    ?? readBodyCode(record.body);
  return { status, code };
}

function parseStatusFromMessage(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  const match = message.match(/\bHTTP (\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Classify a caught memory wire error. Returns 'other' for anything that is not a
 * 404 (network, auth, malformed body, 5xx) so the caller propagates it unchanged.
 */
export function classifyMemoryWireError(error: unknown): MemoryWire404Disposition {
  const { status, code } = extractWire404Signal(error);
  if (status !== 404) return 'other';
  return code === MEMORY_RECORD_NOT_FOUND_CODE ? 'record-missing' : 'method-unavailable';
}

/**
 * The single canonical "the adopted daemon does not serve this verb" rejection.
 * Every consumer (the SDK client's own fallback plus each wire transport) throws
 * THIS so the surfaced message is identical everywhere.
 */
export function memoryVerbUnavailableError(verb: string, cause?: unknown): Error {
  return new Error(
    `memory spine: the adopted daemon does not support the '${verb}' memory verb over the wire — `
    + 'upgrade the daemon to a build that serves it, or run this surface offline (no daemon adopted). '
    + 'A wire client will not read its own local store for this op, because that would break the '
    + 'single-writer invariant and report a divergent local copy as if it were the canonical store.',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The fold a transport's extended-verb catch block runs. Given the caught wire
 * error:
 *  - 'method-unavailable' → throw {@link memoryVerbUnavailableError} (the older
 *    daemon never served this route — a loud, honest reject);
 *  - 'record-missing'     → return normally (the caller decides what a genuine
 *    record-miss means for its return type: `null` for a nullable verb, or a
 *    rethrow for a non-nullable one);
 *  - 'other'              → rethrow the original error unchanged.
 *
 * A nullable record-scoped verb uses it as `foldMemoryWireExtendedError(v, e); return null;`
 * — the fold throws for the version-skew case and only falls through to `null`
 * for a genuine record-miss.
 */
export function foldMemoryWireExtendedError(verb: string, error: unknown): void {
  const disposition = classifyMemoryWireError(error);
  if (disposition === 'method-unavailable') throw memoryVerbUnavailableError(verb, error);
  if (disposition === 'other') throw error;
  // 'record-missing' → fall through; the caller resolves it for its own return type.
}
