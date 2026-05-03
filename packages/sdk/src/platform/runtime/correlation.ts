/**
 * OBS-15: AsyncLocalStorage-based correlation context for request/session/turn/run scoping.
 *
 * Seed at HTTP entry points and session/turn creation so downstream events can
 * automatically attach the correct IDs without explicit threading.
 *
 * Usage:
 * ```ts
 * // Seed at HTTP request entry:
 * correlationCtx.run({ requestId: crypto.randomUUID() }, () => handler(req));
 *
 * // Read anywhere downstream:
 * const { requestId, sessionId } = getCorrelationContext();
 * ```
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation identifiers propagated via AsyncLocalStorage. */
export interface CorrelationContext {
  /** HTTP request ID — seeded by the HTTP listener on every inbound request. */
  readonly requestId?: string;
  /** Session ID — seeded when a session starts or resumes. */
  readonly sessionId?: string;
  /** Run ID — seeded when a run (multi-turn conversation) begins. */
  readonly runId?: string;
  /** Turn ID — seeded when a turn starts within a run. */
  readonly turnId?: string;
}

/** The singleton AsyncLocalStorage instance for correlation context. */
export const correlationCtx = new AsyncLocalStorage<CorrelationContext>();

/**
 * Get the current correlation context, or an empty object if none is active.
 * Safe to call from anywhere — returns {} when no context is running.
 */
export function getCorrelationContext(): Readonly<CorrelationContext> {
  return correlationCtx.getStore() ?? {};
}

/**
 * Run a function within a new correlation context that inherits the current
 * context and overrides the provided fields.
 */
export function withCorrelation<T>(
  overrides: Partial<CorrelationContext>,
  fn: () => T,
): T {
  const current = correlationCtx.getStore() ?? {};
  return correlationCtx.run({ ...current, ...overrides }, fn);
}

/**
 * Run an async function within a new correlation context.
 */
export async function withCorrelationAsync<T>(
  overrides: Partial<CorrelationContext>,
  fn: () => Promise<T>,
): Promise<T> {
  const current = correlationCtx.getStore() ?? {};
  return correlationCtx.run({ ...current, ...overrides }, fn);
}
