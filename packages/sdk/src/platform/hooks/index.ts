export { HookDispatcher } from './dispatcher.js';
export { ChainEngine } from './chain-engine.js';
export { HookActivityTracker } from './activity.js';
export { HookWorkbench, createHookWorkbench } from './workbench.js';
export { createHookApi } from './hook-api.js';
export type {
  CreateHookApiOptions,
  HookApi,
  HookApiDispatcher,
  HookApiWorkbenchRuntime,
  HookContractRecord,
  HookContractSource,
  HookWorkbenchApi,
} from './hook-api.js';
export type {
  HookPhase,
  HookCategory,
  HookEventPath,
  HookEvent,
  HookResult,
  HookType,
  HookDefinition,
  ChainStep,
  HookChain,
  HooksConfig,
} from './types.js';
export type { HookActivityRecord } from './activity.js';
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult } from './workbench.js';
export type { HookExecutionMode, HookAuthority, HookPointContract } from './contracts.js';
import type { AgentManager } from '../tools/agent/index.js';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from './contracts.js';
export { matchesEventPath, matchesMatcher } from './matcher.js';
export { safeEvaluate } from './chain-engine.js';
export { run } from './runner.js';

import { HookActivityTracker } from './activity.js';
import { HookDispatcher } from './dispatcher.js';

export function createHookDispatcher(config: {
  readonly agentManager?: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> | undefined;
  readonly activityTracker?: HookActivityTracker | undefined;
} = {}): HookDispatcher {
  return new HookDispatcher(
    { agentManager: config.agentManager },
    config.activityTracker,
  );
}
