import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { builtinGatewayControlAutomationMethodDescriptors } from './method-catalog-control-automation.js';
import { builtinGatewayControlCompanionMethodDescriptors } from './method-catalog-control-companion.js';
import { builtinGatewayControlCoreMethodDescriptors } from './method-catalog-control-core.js';
import { builtinGatewayControlLiveTurnMethodDescriptors } from './method-catalog-control-live-turn.js';
import { builtinGatewayPowerMethodDescriptors } from './method-catalog-power.js';
import { builtinGatewayDeviceMethodDescriptors } from './method-catalog-devices.js';
import { builtinGatewayMemoryMethodDescriptors } from './method-catalog-memory.js';
import { builtinGatewayVoiceSetupMethodDescriptors } from './method-catalog-voice-setup.js';
import { builtinGatewayFleetMethodDescriptors } from './method-catalog-fleet.js';
import { builtinGatewayHostedSessionMethodDescriptors } from './method-catalog-hosted-sessions.js';

export const builtinGatewayControlMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlCoreMethodDescriptors,
  ...builtinGatewayControlLiveTurnMethodDescriptors,
  ...builtinGatewayHostedSessionMethodDescriptors,
  ...builtinGatewayPowerMethodDescriptors,
  ...builtinGatewayDeviceMethodDescriptors,
  ...builtinGatewayMemoryMethodDescriptors,
  ...builtinGatewayVoiceSetupMethodDescriptors,
  ...builtinGatewayControlCompanionMethodDescriptors,
  ...builtinGatewayControlAutomationMethodDescriptors,
  ...builtinGatewayFleetMethodDescriptors,
];
