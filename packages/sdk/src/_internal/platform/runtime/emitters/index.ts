/**
 * Emitters barrel — re-exports all typed emission wrappers and the EmitterContext.
 *
 * The EmitterContext is the minimal context required by all emitter functions.
 * Construct one from the current session/turn/agent context and pass it through.
 *
 * Usage:
 * ```ts
 * import { emitTurnSubmitted } from '../runtime/emitters/index.js';
 * import { RuntimeEventBus } from '../runtime/events/index.js';
 *
 * const bus = new RuntimeEventBus();
 * const ctx: EmitterContext = { sessionId: '...', traceId: '...', source: 'orchestrator' };
 * emitTurnSubmitted(bus, ctx, { turnId: '...', prompt: 'Hello' });
 * ```
 */
import type { EnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';

/**
 * Emitter context passed to all emission wrapper functions.
 *
 * Extends EnvelopeContext by narrowing `traceId` from optional to required.
 * Emitter callsites always possess a trace context (e.g. from the active turn
 * or session), so requiring it here prevents accidental fallback to a generated
 * UUID that breaks cross-boundary trace correlation. Compare to EnvelopeContext
 * where `traceId` is optional to support low-level envelope construction without
 * a pre-existing trace.
 */
export interface EmitterContext extends EnvelopeContext {
  /** Required trace identifier — must be supplied by the caller at emission time. */
  readonly traceId: string;
}

export * from './session.js';
export * from './turn.js';
export * from './providers.js';
export * from './tools.js';
export * from './tasks.js';
export * from './agents.js';
export * from './workflows.js';
export * from './orchestration.js';
export * from './communication.js';
export * from './planner.js';
export * from './permissions.js';
export * from './plugins.js';
export * from './mcp.js';
export * from './transport.js';
export * from './compaction.js';
export * from './ui.js';
export * from './ops.js';
export * from './forensics.js';
export * from './security.js';
export * from './automation.js';
export * from './routes.js';
export * from './control-plane.js';
export * from './deliveries.js';
export * from './watchers.js';
export * from './surfaces.js';
export * from './knowledge.js';
