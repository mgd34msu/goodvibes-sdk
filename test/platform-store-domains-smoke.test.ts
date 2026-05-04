/**
 * Coverage-gap smoke test — platform/runtime/store/domains
 * Verifies that each store domain module loads without throwing.
 * Closes coverage gap: platform/runtime/store/domains per-domain (eighth-review)
 */

import { describe, expect, test } from 'bun:test';

// Import each domain to verify it loads without errors
import * as acp from '../packages/sdk/src/platform/runtime/store/domains/acp.js';
import * as agents from '../packages/sdk/src/platform/runtime/store/domains/agents.js';
import * as automation from '../packages/sdk/src/platform/runtime/store/domains/automation.js';
import * as conversation from '../packages/sdk/src/platform/runtime/store/domains/conversation.js';
import * as daemon from '../packages/sdk/src/platform/runtime/store/domains/daemon.js';
import * as discovery from '../packages/sdk/src/platform/runtime/store/domains/discovery.js';
import * as git from '../packages/sdk/src/platform/runtime/store/domains/git.js';
import * as intelligence from '../packages/sdk/src/platform/runtime/store/domains/intelligence.js';
import * as mcp from '../packages/sdk/src/platform/runtime/store/domains/mcp.js';
import * as model from '../packages/sdk/src/platform/runtime/store/domains/model.js';
import * as orchestration from '../packages/sdk/src/platform/runtime/store/domains/orchestration.js';
import * as permissions from '../packages/sdk/src/platform/runtime/store/domains/permissions.js';
import * as session from '../packages/sdk/src/platform/runtime/store/domains/session.js';
import * as tasks from '../packages/sdk/src/platform/runtime/store/domains/tasks.js';

describe('platform/runtime/store/domains — module load smoke', () => {
  test('acp domain loads without error', () => {
    expect(acp).toBeDefined();
  });

  test('agents domain loads without error', () => {
    expect(agents).toBeDefined();
  });

  test('automation domain loads without error', () => {
    expect(automation).toBeDefined();
  });

  test('conversation domain loads without error', () => {
    expect(conversation).toBeDefined();
  });

  test('daemon domain loads without error', () => {
    expect(daemon).toBeDefined();
  });

  test('discovery domain loads without error', () => {
    expect(discovery).toBeDefined();
  });

  test('git domain loads without error', () => {
    expect(git).toBeDefined();
  });

  test('intelligence domain loads without error', () => {
    expect(intelligence).toBeDefined();
  });

  test('mcp domain loads without error', () => {
    expect(mcp).toBeDefined();
  });

  test('model domain loads without error', () => {
    expect(model).toBeDefined();
  });

  test('orchestration domain loads without error', () => {
    expect(orchestration).toBeDefined();
  });

  test('permissions domain loads without error', () => {
    expect(permissions).toBeDefined();
  });

  test('session domain loads without error', () => {
    expect(session).toBeDefined();
  });

  test('tasks domain loads without error', () => {
    expect(tasks).toBeDefined();
  });
});
