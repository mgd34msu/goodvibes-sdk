/**
 * Coverage-gap smoke test — platform/runtime/store/domains
 * Verifies that each store domain's createInitial*State() factory function
 * returns an object with the expected base shape and key-field values.
 * Closes coverage gap: platform/runtime/store/domains per-domain (eighth-review)
 */

import { describe, expect, test } from 'bun:test';
import { createInitialAcpState } from '../packages/sdk/src/platform/runtime/store/domains/acp.js';
import { createInitialAgentsState } from '../packages/sdk/src/platform/runtime/store/domains/agents.js';
import { createInitialAutomationState } from '../packages/sdk/src/platform/runtime/store/domains/automation.js';
import { createInitialConversationState } from '../packages/sdk/src/platform/runtime/store/domains/conversation.js';
import { createInitialDaemonState } from '../packages/sdk/src/platform/runtime/store/domains/daemon.js';
import { createInitialDiscoveryState } from '../packages/sdk/src/platform/runtime/store/domains/discovery.js';
import { createInitialGitState } from '../packages/sdk/src/platform/runtime/store/domains/git.js';
import { createInitialIntelligenceState } from '../packages/sdk/src/platform/runtime/store/domains/intelligence.js';
import { createInitialMcpState } from '../packages/sdk/src/platform/runtime/store/domains/mcp.js';
import { createInitialModelState } from '../packages/sdk/src/platform/runtime/store/domains/model.js';
import { createInitialOrchestrationState } from '../packages/sdk/src/platform/runtime/store/domains/orchestration.js';
import { createInitialPermissionsState } from '../packages/sdk/src/platform/runtime/store/domains/permissions.js';
import { createInitialSessionState } from '../packages/sdk/src/platform/runtime/store/domains/session.js';
import { createInitialTasksState } from '../packages/sdk/src/platform/runtime/store/domains/tasks.js';

/** All domain states must have a numeric revision field. */
function assertBaseShape(state: unknown, domainName: string) {
  const s = state as Record<string, unknown>;
  expect(typeof s.revision, `${domainName}: revision should be a number`).toBe('number');
}

describe('platform/runtime/store/domains — behavior smoke', () => {
  test('createInitialAcpState returns correct shape', () => {
    const state = createInitialAcpState();
    assertBaseShape(state, 'acp');
    expect(state.initialized).toBe(false);
    expect(state.connections).toBeInstanceOf(Map);
  });

  test('createInitialAgentsState returns correct shape', () => {
    const state = createInitialAgentsState();
    assertBaseShape(state, 'agents');
    expect(state.agents).toBeInstanceOf(Map);
    expect(Array.isArray(state.activeAgentIds)).toBe(true);
    expect(state.activeAgentIds.length).toBe(0);
    expect(state.peakConcurrency).toBe(0);
  });

  test('createInitialAutomationState returns correct shape', () => {
    const state = createInitialAutomationState();
    assertBaseShape(state, 'automation');
  });

  test('createInitialConversationState returns correct shape', () => {
    const state = createInitialConversationState();
    assertBaseShape(state, 'conversation');
    expect(state.turnState).toBe('idle');
  });

  test('createInitialDaemonState returns correct shape', () => {
    const state = createInitialDaemonState();
    assertBaseShape(state, 'daemon');
  });

  test('createInitialDiscoveryState returns correct shape', () => {
    const state = createInitialDiscoveryState();
    assertBaseShape(state, 'discovery');
  });

  test('createInitialGitState returns correct shape', () => {
    const state = createInitialGitState();
    assertBaseShape(state, 'git');
  });

  test('createInitialIntelligenceState returns correct shape', () => {
    const state = createInitialIntelligenceState();
    assertBaseShape(state, 'intelligence');
  });

  test('createInitialMcpState returns correct shape', () => {
    const state = createInitialMcpState();
    assertBaseShape(state, 'mcp');
  });

  test('createInitialModelState returns correct shape', () => {
    const state = createInitialModelState();
    assertBaseShape(state, 'model');
  });

  test('createInitialOrchestrationState returns correct shape', () => {
    const state = createInitialOrchestrationState();
    assertBaseShape(state, 'orchestration');
  });

  test('createInitialPermissionsState returns correct shape', () => {
    const state = createInitialPermissionsState();
    assertBaseShape(state, 'permissions');
  });

  test('createInitialSessionState returns correct shape', () => {
    const state = createInitialSessionState();
    assertBaseShape(state, 'session');
  });

  test('createInitialTasksState returns correct shape', () => {
    const state = createInitialTasksState();
    assertBaseShape(state, 'tasks');
  });
});
