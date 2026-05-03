import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { builtinGatewayControlAutomationMethodDescriptors } from './method-catalog-control-automation.js';
import { builtinGatewayControlCoreMethodDescriptors } from './method-catalog-control-core.js';

export const builtinGatewayControlMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlCoreMethodDescriptors,
  ...builtinGatewayControlAutomationMethodDescriptors,
];
