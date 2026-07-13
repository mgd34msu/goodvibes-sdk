/**
 * Approval decisions persist and generalize; deny is feedback.
 *
 * Acceptance bar:
 *   - a granted command-class rule survives restart and suppresses re-asks
 *   - an edit approval scoped to a path does not authorize other paths
 *   - deny-with-reason yields a continuing-turn structured result
 *   - two concurrent identical asks get one prompt and both resolve
 *   - a remember-tier decision sweeps queued covered asks
 *   - rules are listable/deletable via the permissions.rules.* settings verbs
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';
import { UserPermissionRuleStore } from '../packages/sdk/src/platform/permissions/user-rule-store.js';
import { buildRememberOptions, matchDurableRules } from '../packages/sdk/src/platform/permissions/approval-rules.js';
import { evaluatePathScopeRule, extractPathArgs } from '../packages/sdk/src/platform/runtime/permissions/rules/path-scope.js';
import { normalize as pathNormalize } from 'node:path';
import { buildDenialErrorMessage, buildToolDenial } from '../packages/sdk/src/platform/permissions/denial.js';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import { registerPermissionRulesGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/permission-rules.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';

const WORKSPACE = '/tmp/gv-approval-workspace';

function makeConfigReader(mode: 'prompt' | 'custom' = 'prompt'): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => WORKSPACE,
    getSnapshot: () => ({ permissions: { mode, tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

function makeManager(
  store: UserPermissionRuleStore,
  onPrompt: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>,
): PermissionManager {
  return new PermissionManager(onPrompt, makeConfigReader(), makePolicyRuntimeState(), null, null, store);
}

function execArgs(...cmds: string[]): Record<string, unknown> {
  return { commands: cmds.map((cmd) => ({ cmd })) };
}

describe('durable approval rules', () => {
  test('a granted command-class rule survives restart and suppresses re-asks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const rulePath = join(dir, 'permission-rules.json');
      const store = new UserPermissionRuleStore(rulePath);
      await store.init();

      let prompts = 0;
      const manager = makeManager(store, async () => {
        prompts += 1;
        return { approved: true, rememberTier: 'command-class' };
      });

      const first = await manager.checkDetailed('exec', execArgs('git commit -m "one"'));
      expect(first.approved).toBe(true);
      expect(prompts).toBe(1);

      // The tenth git command of the session must not re-ask.
      for (const cmd of ['git push', 'git status', 'git log --oneline']) {
        const result = await manager.checkDetailed('exec', execArgs(cmd));
        expect(result.approved).toBe(true);
      }
      expect(prompts).toBe(1);

      // RESTART: a fresh store + manager over the same file.
      const rebornStore = new UserPermissionRuleStore(rulePath);
      await rebornStore.init();
      const reborn = makeManager(rebornStore, async () => {
        throw new Error('re-asked after restart — the durable rule was lost');
      });
      const afterRestart = await reborn.checkDetailed('exec', execArgs('git commit -m "two"'));
      expect(afterRestart.approved).toBe(true);
      expect(afterRestart.sourceLayer).toBe('user_rule');
      expect(afterRestart.reasonCode).toBe('user_rule_allow');

      // A non-git command still asks — the class grant does not blanket exec.
      let asked = false;
      const askingManager = makeManager(rebornStore, async () => {
        asked = true;
        return { approved: false };
      });
      await askingManager.checkDetailed('exec', execArgs('npm publish'));
      expect(asked).toBe(true);

      // A mixed batch (git + non-git) must not ride in on the git grant.
      let askedMixed = false;
      const mixedManager = makeManager(rebornStore, async () => {
        askedMixed = true;
        return { approved: false };
      });
      await mixedManager.checkDetailed('exec', execArgs('git status', 'curl evil.example'));
      expect(askedMixed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an edit approval scoped to a path does not authorize other paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
      await store.init();

      let prompts = 0;
      const manager = makeManager(store, async () => {
        prompts += 1;
        return { approved: true, rememberTier: 'path' };
      });

      const first = await manager.checkDetailed('edit', {
        edits: [{ path: `${WORKSPACE}/src/a.ts`, find: 'x', replace: 'y' }],
      });
      expect(first.approved).toBe(true);
      expect(prompts).toBe(1);

      // Same directory: covered, no re-ask.
      const sameDir = await manager.checkDetailed('edit', {
        edits: [{ path: `${WORKSPACE}/src/b.ts`, find: 'x', replace: 'y' }],
      });
      if (prompts !== 1) {
        // TEMP CI DIAGNOSTIC — remove after root-causing the CI-only re-ask.
        const bArgs = { edits: [{ path: `${WORKSPACE}/src/b.ts`, find: 'x', replace: 'y' }] };
        const rulesNow = store.rules();
        const directMatch = matchDurableRules(rulesNow, 'edit', bArgs, { projectRoot: WORKSPACE });
        const pathScopeResults = rulesNow.map((r) =>
          r.type === 'path-scope' ? evaluatePathScopeRule(r, 'edit', bArgs, WORKSPACE) : { skipped: r.type });
        // Inline copy of the platform globToRegex to capture the exact regex.
        const glob = (pattern: string): RegExp => new RegExp('^' + pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, ' DOUBLESTAR ')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/ DOUBLESTAR /g, '.*') + '$');
        const bPath = `${WORKSPACE}/src/b.ts`;
        const pat = (rulesNow[0]?.type === 'path-scope' ? rulesNow[0].pathPatterns[0] : '') ?? '';
        const rx = glob(pat);
        const normB = pathNormalize(bPath);
        const extracted = extractPathArgs(bArgs);
        const mkRule = (patterns: string[]) => ({
          type: 'path-scope' as const, id: 'diag', origin: 'user' as const,
          effect: 'allow' as const, toolPattern: ['edit', 'write'], pathPatterns: patterns,
        });
        const probeExact = evaluatePathScopeRule(mkRule([bPath]), 'edit', bArgs, WORKSPACE).matched;
        const probeStar = evaluatePathScopeRule(mkRule([`${WORKSPACE}/src/*`]), 'edit', bArgs, WORKSPACE).matched;
        const probeStarStar = evaluatePathScopeRule(mkRule([`${WORKSPACE}/src/**`]), 'edit', bArgs, WORKSPACE).matched;
        console.error('[DIAG] same-dir re-ask', JSON.stringify({
          prompts,
          firstReason: first.reasonCode,
          sameDirReason: sameDir.reasonCode,
          rulesNowCount: rulesNow.length,
          directMatch,
          pathScopeMatched: pathScopeResults.map((r) => (r as { matched?: boolean }).matched),
          regexSource: rx.source,
          regexTestB_raw: rx.test(bPath),
          regexTestB_normalized: rx.test(normB),
          normB,
          normBEqualsRaw: normB === bPath,
          extracted,
          extractedEqualsRaw: extracted.length === 1 && extracted[0] === bPath,
          probeExact,
          probeStar,
          probeStarStar,
          evalFnSource: evaluatePathScopeRule.toString().slice(0, 1400),
          tmpdir: tmpdir(),
        }, null, 2));
      }
      expect(sameDir.approved).toBe(true);
      expect(prompts).toBe(1);

      // Different directory: NOT covered — prompts again.
      await manager.checkDetailed('edit', {
        edits: [{ path: `${WORKSPACE}/secrets/c.ts`, find: 'x', replace: 'y' }],
      });
      expect(prompts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the ask payload carries the remember tier options for any surface', () => {
    const options = buildRememberOptions('exec', execArgs('git commit -m "x"'));
    const tiers = options.map((option) => option.tier);
    expect(tiers).toEqual(['exact', 'command-class', 'tool', 'session']);
    expect(options.find((option) => option.tier === 'command-class')?.label).toContain('git');
  });

  test('deny-with-reason yields the structured user-declined result for a continuing turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
      await store.init();
      const manager = makeManager(store, async () => ({
        approved: false,
        reason: 'use bun, not npm',
      }));

      const result = await manager.checkDetailed('exec', execArgs('npm install'));
      expect(result.approved).toBe(false);
      expect(result.reasonCode).toBe('user_denied');
      expect(result.userReason).toBe('use bun, not npm');

      // The exact structured result the model sees on the CONTINUING turn —
      // same shape as the plan-mode prior art, with the user's words on it.
      const source = { reasonCode: result.reasonCode, sourceLayer: result.sourceLayer, userReason: result.userReason };
      const denial = buildToolDenial(source);
      expect(denial).toEqual({ denied: true, reason: 'user_denied', scope: 'user_prompt', detail: 'use bun, not npm' });
      const message = buildDenialErrorMessage('exec', source);
      expect(message).toContain('The user said: "use bun, not npm"');
      expect(message).toContain('continue without it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('approval broker coalescing and sweep', () => {
  function makeRequest(callId: string, tool: string, args: Record<string, unknown>): PermissionPromptRequest {
    return {
      callId,
      tool,
      args,
      category: 'execute',
      analysis: { classification: 'generic', riskLevel: 'medium', summary: 's', reasons: [] },
    } as unknown as PermissionPromptRequest;
  }

  test('two concurrent identical asks get one prompt and both resolve', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    let prompts = 0;
    const localPrompt = async (): Promise<PermissionPromptDecision> => {
      prompts += 1;
      await Bun.sleep(10);
      return { approved: true };
    };

    const args = execArgs('git status');
    const [first, second] = await Promise.all([
      broker.requestApproval({ request: makeRequest('c1', 'exec', args), sessionId: 's1', localPrompt }),
      broker.requestApproval({ request: makeRequest('c2', 'exec', args), sessionId: 's1', localPrompt }),
    ]);
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    expect(prompts).toBe(1);
    // One record, resolved once.
    const records = broker.listApprovals();
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('approved');
  });

  test('a remember-tier decision sweeps queued asks the rule covers', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });

    // Two DIFFERENT git commands queued (not identical — no coalescing).
    const p1 = broker.requestApproval({ request: makeRequest('c1', 'exec', execArgs('git commit -m "x"')), sessionId: 's1' });
    const p2 = broker.requestApproval({ request: makeRequest('c2', 'exec', execArgs('git push origin main')), sessionId: 's1' });
    // And one non-git ask that the git grant must NOT sweep.
    const p3 = broker.requestApproval({ request: makeRequest('c3', 'exec', execArgs('npm publish')), sessionId: 's1' });

    // Registration is async (store load + persist) — let the records land.
    await Bun.sleep(5);
    const pending = broker.listApprovals().filter((record) => record.status === 'pending');
    expect(pending).toHaveLength(3);
    const target = pending.find((record) => record.callId === 'c1')!;

    await broker.resolveApproval(target.id, {
      approved: true,
      rememberTier: 'command-class',
      actor: 'operator',
    });

    const first = await p1;
    const second = await p2;
    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);

    const after = broker.listApprovals();
    expect(after.filter((record) => record.status === 'approved')).toHaveLength(2);
    // The npm ask is still pending — resolve it so nothing dangles.
    const npmAsk = after.find((record) => record.callId === 'c3')!;
    expect(npmAsk.status).toBe('pending');
    await broker.resolveApproval(npmAsk.id, { approved: false, reason: 'not now', actor: 'operator' });
    const third = await p3;
    expect(third.approved).toBe(false);
    expect(third.reason).toBe('not now');
  });
});

describe('permissions.rules.* settings surface', () => {
  test('rules are listable and deletable via the gateway verbs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rules-'));
    try {
      const store = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
      await store.init();
      const manager = makeManager(store, async () => ({ approved: true, rememberTier: 'command-class' }));
      await manager.checkDetailed('exec', execArgs('git commit -m "x"'));

      const catalog = new GatewayMethodCatalog();
      registerPermissionRulesGatewayMethods(catalog, { userRuleStore: store });
      expect(catalog.hasHandler('permissions.rules.list')).toBe(true);
      expect(catalog.hasHandler('permissions.rules.delete')).toBe(true);

      const ctx = { context: { admin: true } } as const;
      const listed = await catalog.invoke('permissions.rules.list', { ...ctx, body: {} }) as {
        rules: { id: string; effect: string; tier: string; tool: string }[];
      };
      expect(listed.rules).toHaveLength(1);
      expect(listed.rules[0]!.effect).toBe('allow');
      expect(listed.rules[0]!.tier).toBe('command-class');
      expect(listed.rules[0]!.tool).toBe('exec');

      const deleted = await catalog.invoke('permissions.rules.delete', { ...ctx, body: { ruleId: listed.rules[0]!.id } }) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);
      const relisted = await catalog.invoke('permissions.rules.list', { ...ctx, body: {} }) as { rules: unknown[] };
      expect(relisted.rules).toHaveLength(0);

      // Deleting the grant means the next ask prompts again.
      let asked = false;
      const askAgain = makeManager(store, async () => {
        asked = true;
        return { approved: false };
      });
      // The old manager's session cache would suppress; a fresh manager models a new session.
      await askAgain.checkDetailed('exec', execArgs('git commit -m "y"'));
      expect(asked).toBe(true);

      const missing = await catalog.invoke('permissions.rules.delete', { ...ctx, body: { ruleId: 'nope' } }) as { deleted: boolean };
      expect(missing.deleted).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
