/**
 * The trigger family: stream watchers, model-free condition checks, and
 * one-shot on-exit process-lifecycle triggers over one supervision spine.
 *
 * Gated by `watchers.triggers.enabled`, which ships false.
 */
export * from './types.js';
export * from './validation.js';
export * from './extract.js';
export * from './rules.js';
export * from './supervision.js';
export * from './store.js';
export * from './grants.js';
export * from './probes.js';
export * from './process-triggers.js';
export * from './stream-watchers.js';
export * from './manager.js';
export * from './manager-streams.js';
// The real effects behind the ports above (ProcessManager-backed on-exit host,
// Bun stream host, agent-turn/grant executor). A consumer that composes its own
// RuntimeServices needs these to construct a working TriggerManager rather than
// re-implementing the hosts.
export * from './hosts.js';
