export { HookDispatcher } from './dispatcher.js';
export { ChainEngine } from './chain-engine.js';
export { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
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
} from '@pellux/goodvibes-sdk/platform/hooks/types';
export type { HookActivityRecord } from '@pellux/goodvibes-sdk/platform/hooks/activity';
export type { HookAuthoringAction, HookConfigInspection, HookSimulationResult } from './workbench.js';
export type { HookExecutionMode, HookAuthority, HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks/contracts';
import type { AgentManager } from '../tools/agent/index.js';
export {
  listHookPointContracts,
  getHookPointContract,
  parseHookPath,
} from '@pellux/goodvibes-sdk/platform/hooks/contracts';

import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
import { HookDispatcher } from './dispatcher.js';

export function createHookDispatcher(config: {
  readonly agentManager?: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>;
  readonly activityTracker?: HookActivityTracker;
} = {}): HookDispatcher {
  return new HookDispatcher(
    { agentManager: config.agentManager },
    config.activityTracker,
  );
}
