/**
 * phases/index.ts — barrel export for all tool execution phase functions.
 *
 * Each export is a pure async function conforming to PhaseFunction.
 * The pipeline is assembled in phased-executor.ts.
 */
export { validatePhase } from './validate.js';
export { prehookPhase } from './prehook.js';
export { permissionPhase } from './permission.js';
export { budgetPhase } from './budget.js';
export { executePhase } from './execute.js';
export { mapOutputPhase } from './map-output.js';
export { posthookPhase } from './posthook.js';
