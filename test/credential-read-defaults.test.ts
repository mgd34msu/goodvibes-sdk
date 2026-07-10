/**
 * credential-read-defaults.test.ts
 *
 * Shipped default protection for reads of well-known credential files: a read
 * of a credential store is NOT silently auto-allowed in the default prompt
 * posture — it falls through to the ask/prompt path — while ordinary reads and a
 * workspace-local .env stay auto-allowed. These are ordinary permission-settings
 * defaults (managed rules / a read guard), NOT the frozen exec block.
 */
import { describe, expect, test } from 'bun:test';
import {
  CREDENTIAL_READ_PATH_PATTERNS,
  SHIPPED_CREDENTIAL_READ_RULES,
  matchesShippedCredentialReadPath,
} from '../packages/sdk/src/platform/permissions/credential-read-defaults.ts';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.ts';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.ts';

const WORKSPACE = '/tmp/gv-cred-read-workspace';

describe('matchesShippedCredentialReadPath', () => {
  test('matches well-known credential stores', () => {
    expect(matchesShippedCredentialReadPath('/home/alice/.ssh/id_rsa').matched).toBe(true);
    expect(matchesShippedCredentialReadPath('/Users/bob/.aws/credentials').matched).toBe(true);
    expect(matchesShippedCredentialReadPath('/home/c/.config/google-chrome/Default/Login Data').matched).toBe(true);
    expect(matchesShippedCredentialReadPath('/home/c/.gnupg/secring.gpg').matched).toBe(true);
  });

  test('does not match ordinary files', () => {
    expect(matchesShippedCredentialReadPath('/home/alice/project/src/index.ts').matched).toBe(false);
    expect(matchesShippedCredentialReadPath('/home/alice/README.md').matched).toBe(false);
  });

  test('.env is gated only OUTSIDE the workspace', () => {
    expect(matchesShippedCredentialReadPath(`${WORKSPACE}/.env`, { projectRoot: WORKSPACE }).matched).toBe(false);
    expect(matchesShippedCredentialReadPath('/home/alice/.env', { projectRoot: WORKSPACE }).matched).toBe(true);
    expect(matchesShippedCredentialReadPath('/home/alice/.env.production', { projectRoot: WORKSPACE }).matched).toBe(true);
  });

  test('shipped rules are managed deny path-scope rules (not the frozen block)', () => {
    expect(SHIPPED_CREDENTIAL_READ_RULES.length).toBeGreaterThan(0);
    for (const rule of SHIPPED_CREDENTIAL_READ_RULES) {
      expect(rule.origin).toBe('managed');
      expect(rule.effect).toBe('deny');
      expect(rule.type).toBe('path-scope');
    }
    expect(CREDENTIAL_READ_PATH_PATTERNS.length).toBeGreaterThan(0);
  });
});

function makeConfigReader(): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => WORKSPACE,
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

describe('PermissionManager — shipped credential-read gate (prompt mode)', () => {
  test('a credential read is NOT auto-allowed — it reaches the prompt (ask)', async () => {
    let prompted = false;
    const manager = new PermissionManager(
      async () => { prompted = true; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const result = await manager.checkDetailed('read', { path: '/home/alice/.ssh/id_rsa' });
    expect(prompted).toBe(true);
    expect(result.approved).toBe(false);
  });

  test('an ordinary read is auto-allowed without a prompt', async () => {
    let prompted = false;
    const manager = new PermissionManager(
      async () => { prompted = true; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const result = await manager.checkDetailed('read', { path: `${WORKSPACE}/src/index.ts` });
    expect(prompted).toBe(false);
    expect(result.approved).toBe(true);
  });

  test('a workspace-local .env stays auto-allowed', async () => {
    let prompted = false;
    const manager = new PermissionManager(
      async () => { prompted = true; return { approved: false, remember: false }; },
      makeConfigReader(),
      makePolicyRuntimeState(),
      null,
      null,
    );
    const result = await manager.checkDetailed('read', { path: `${WORKSPACE}/.env` });
    expect(prompted).toBe(false);
    expect(result.approved).toBe(true);
  });
});
