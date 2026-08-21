/**
 * runtime-seam.ts, the SDK runtime surface under the names the terminal
 * front-ends reach it by.
 *
 * The two terminal products each keep a `src/runtime/index.ts` barrel that
 * re-exports the SDK's public runtime seams (state, store, ui, observability,
 * settings, sandbox) plus flattened aliases over the `bootstrap`, `operations`,
 * `security` and `transport` namespace objects. Their test suites imported
 * subjects through that barrel, so the tests read as `from '@/runtime/index.ts'`
 * even when every symbol involved is SDK-owned.
 *
 * Those tests now live here. This helper gives them the same names from the
 * SDK's own modules, so what they assert is the SDK implementation and not a
 * consumer's re-export of it. Two of the barrel's names were consumer-local
 * re-implementations rather than re-exports, `extractForwardedClientIp` is the
 * one that reached these tests, and it is bound below to the SDK's function in
 * platform/runtime/network, which is the implementation that actually ships.
 */

import {
  bootstrap,
  operations,
  security,
  transport,
} from '@pellux/goodvibes-sdk/platform/runtime';
import type {
  operations as Operations,
  security as Security,
} from '@pellux/goodvibes-sdk/platform/runtime';
// `Playbook` is not re-exported from the `operations` namespace (only the
// playbook instances are), so there is no public, bare-specifier name for it.
// Imported directly from source, matching the resolution style the rest of
// this test suite already uses for SDK-internal types, purely to give the
// seven playbook re-exports below an explicit annotation; without one, `tsc`
// cannot name their inferred type across the dist/src module-instance split
// (TS2883).
import type { Playbook } from '../../packages/sdk/src/platform/runtime/ops/types.ts';

export * from '@pellux/goodvibes-sdk/platform/runtime/state';
export * from '@pellux/goodvibes-sdk/platform/runtime/store';
export * from '@pellux/goodvibes-sdk/platform/runtime/ui';
export * from '@pellux/goodvibes-sdk/platform/runtime/observability';

export type {
  TaskEvent,
  TurnEvent,
} from '@pellux/goodvibes-sdk/events';

// Bootstrap seam.
export const loadRuntimeSystemPrompt = bootstrap.loadRuntimeSystemPrompt;
export const loadBootstrapSystemPrompt = bootstrap.loadRuntimeSystemPrompt;

// Operations seam.
export const McpPermissionManager = operations.McpPermissionManager;
export type McpPermissionManager = InstanceType<typeof operations.McpPermissionManager>;
export const DEFAULT_RECONNECT_CONFIG = operations.DEFAULT_RECONNECT_CONFIG;
export const canTransition = operations.canTransition;
export const applyTransition = operations.applyTransition;
export const isOperational = operations.isOperational;
export const isTerminal = operations.isTerminal;
export const reachableFrom = operations.reachableFrom;
export type McpServerState = Operations.McpServerState;
export const PhasedToolExecutor = operations.PhasedToolExecutor;
export type PhasedToolExecutor = InstanceType<typeof operations.PhasedToolExecutor>;
export type ToolRuntimeContext = Operations.ToolRuntimeContext;
export const getDistributedNodeHostContract = operations.getDistributedNodeHostContract;
export const compactionFailurePlaybook: Playbook = operations.compactionFailurePlaybook;
export const exportRecoveryPlaybook: Playbook = operations.exportRecoveryPlaybook;
export const permissionDeadlockPlaybook: Playbook = operations.permissionDeadlockPlaybook;
export const pluginDegradationPlaybook: Playbook = operations.pluginDegradationPlaybook;
export const reconnectFailurePlaybook: Playbook = operations.reconnectFailurePlaybook;
export const sessionUnrecoverablePlaybook: Playbook = operations.sessionUnrecoverablePlaybook;
export const stuckTurnPlaybook: Playbook = operations.stuckTurnPlaybook;

// Security seam.
export const LayeredPolicyEvaluator = security.LayeredPolicyEvaluator;
export type LayeredPolicyEvaluator = InstanceType<typeof security.LayeredPolicyEvaluator>;
export const runSafetyChecks = security.runSafetyChecks;
export const classifySegment = security.classifySegment;
export const classifyCommand = security.classifyCommand;
export const canonicalize = security.canonicalize;
export const higherPriority = security.higherPriority;
export type CommandSegment = Security.CommandSegment;

// Transport seam.
export const createHttpJsonTransport = transport.createHttpJsonTransport;
export const openServerSentEventStream = transport.openServerSentEventStream;
export const createPeerRemoteClient = transport.createPeerRemoteClient;
export const extractForwardedClientIp = transport.extractForwardedClientIp;
