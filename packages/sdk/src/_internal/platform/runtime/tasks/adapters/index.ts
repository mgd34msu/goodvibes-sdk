/**
 * Task adapter barrel — re-exports all subsystem-to-RuntimeTask bridge adapters.
 *
 * Each adapter converts a subsystem-specific task representation into the
 * unified RuntimeTask model and handles lifecycle transitions.
 */

export { ProcessTaskAdapter } from './process-adapter.js';
export type { ProcessOwner } from './process-adapter.js';

export { AgentTaskAdapter } from './agent-adapter.js';
export type { AgentOwner } from './agent-adapter.js';

export { AcpTaskAdapter } from './acp-adapter.js';

export { SchedulerTaskAdapter } from './scheduler-adapter.js';
