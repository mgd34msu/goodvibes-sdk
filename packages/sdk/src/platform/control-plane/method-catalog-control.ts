import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { builtinGatewayControlAutomationMethodDescriptors } from './method-catalog-control-automation.js';
import { builtinGatewayControlCompanionMethodDescriptors } from './method-catalog-control-companion.js';
import { builtinGatewayControlCoreMethodDescriptors } from './method-catalog-control-core.js';
import { builtinGatewayControlLiveTurnMethodDescriptors } from './method-catalog-control-live-turn.js';
import { builtinGatewayPowerMethodDescriptors } from './method-catalog-power.js';
import { builtinGatewayFleetMethodDescriptors } from './method-catalog-fleet.js';

export const builtinGatewayControlMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlCoreMethodDescriptors,
  ...builtinGatewayControlLiveTurnMethodDescriptors,
  ...builtinGatewayPowerMethodDescriptors,
  ...builtinGatewayControlCompanionMethodDescriptors,
  ...builtinGatewayControlAutomationMethodDescriptors,
  ...builtinGatewayFleetMethodDescriptors,
];
