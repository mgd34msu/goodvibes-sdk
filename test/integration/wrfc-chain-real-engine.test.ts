/**
 * A WRFC chain through the real stack: the daemon-grade runtime composition
 * (createRuntimeServices) with its real AgentManager, AgentOrchestrator, tool
 * registry, WrfcController, orchestration engine and fix workstream runner,
 * in a real git repository, with only the model scripted.
 *
 * The scripted model plays each agent the way a real one would, through real
 * tool calls: the engineer writes src/math.ts with the bug still in it, the
 * first review fails with one finding citing that file, the planned fix cycle's
 * engineer writes the correction in its own item worktree, the engine's item
 * review passes it, and the chain's re-review of the merged result passes.
 *
 * What must hold for the test to pass, and what breaks it:
 *  - the chain reaches the fix phase after the failing review (a controller
 *    that completes or fails on the first review never gets there);
 *  - the fix cycle's work is merged into the chain worktree and the passed
 *    chain lands it on the user's branch as a commit (a fix that stays on its
 *    item branch, or a chain that never lands, leaves main with `a - b`).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../../packages/sdk/src/platform/runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../packages/sdk/src/platform/runtime/services.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../../packages/sdk/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../../packages/sdk/src/platform/providers/registry.ts';
import type { WrfcChain } from '../../packages/sdk/src/platform/agents/wrfc-types.ts';

const PROVIDER = 'scripted';
const MODEL = 'scripted-1';
const TASK = 'Fix add() in src/math.ts so it returns the sum of its two arguments.';
const BUGGY = 'export function add(a: number, b: number): number {\n  return a - b;\n}\n';
const STILL_BUGGY = '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a - b;\n}\n';
const FIXED = '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n';
const CHAIN_DEADLINE_MS = 90_000;

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

function fenced(report: Record<string, unknown>): string {
  return ['```json', JSON.stringify(report), '```'].join('\n');
}

function engineerReport(summary: string): string {
  return fenced({
    version: 1, archetype: 'engineer', summary, gatheredContext: [], plannedActions: [],
    appliedChanges: [summary], filesCreated: [], filesModified: ['src/math.ts'], filesDeleted: [],
    decisions: [], issues: [], uncertainties: [], constraints: [],
  });
}

function reviewerReport(passed: boolean): string {
  return fenced({
    version: 1, archetype: 'reviewer', summary: passed ? 'add() returns the sum' : 'add() still subtracts',
    score: passed ? 10 : 4, passed, dimensions: [],
    issues: passed ? [] : [{ severity: 'major', description: 'add() still returns a - b; it must return a + b.', file: 'src/math.ts', line: 3, pointValue: 6 }],
    constraintFindings: [],
    acceptanceChecklist: [{ item: 'add is exported from src/math.ts', verified: true, evidence: 'read src/math.ts' }],
  });
}

function text(content: string): ChatResponse {
  return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, stopReason: 'completed' } as unknown as ChatResponse;
}

function writeCall(id: string, content: string): ChatResponse {
  return {
    content: '',
    toolCalls: [{ id, name: 'write', arguments: { files: [{ path: 'src/math.ts', content, mode: 'overwrite' }] } }],
    usage: { inputTokens: 10, outputTokens: 10 },
    stopReason: 'tool_call',
  } as unknown as ChatResponse;
}

/** What the scripted model was asked to do, in order. */
const played: string[] = [];
let chainReviews = 0;

/**
 * One model for every agent, answering by what the agent was asked. An agent
 * whose last message is a tool result has done its write and now reports.
 */
function scriptedProvider(): LLMProvider {
  return {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const first = String((request.messages[0] as { content?: unknown } | undefined)?.content ?? '');
      const wrote = request.messages.some((m) => (m as { role?: string }).role === 'tool');
      if (first.includes('Assess the following work item')) {
        played.push('item-review');
        return text(reviewerReport(true));
      }
      if (first.includes('WRFC Review Request')) {
        chainReviews += 1;
        played.push(`chain-review-${chainReviews}`);
        return text(reviewerReport(chainReviews > 1));
      }
      if (first.includes('FIX THIS REVIEW FINDING')) {
        if (wrote) return text(engineerReport('add() now returns a + b'));
        played.push('fix-engineer');
        return writeCall('fix-write', FIXED);
      }
      if (wrote) return text(engineerReport('documented add()'));
      played.push('engineer');
      return writeCall('engineer-write', STILL_BUGGY);
    },
  } as unknown as LLMProvider;
}

let root: string;
let repo: string;
let services: RuntimeServices;
let chain: WrfcChain | undefined;
let sawFixing = false;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wrfc-real-engine-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Fixture Owner']);
  git(repo, ['config', 'user.email', 'owner@example.test']);
  writeFileSync(join(repo, 'src', 'math.ts'), BUGGY);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);

  const configManager = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), workingDir: repo, homeDir: root });
  // Nobody answers permission prompts here; background agents run the way a
  // user who exempted them runs them. autoCommit is the default, stated here
  // because the landing assertion depends on it.
  configManager.set('permissions.backgroundAgents', 'allow-all');
  configManager.set('wrfc.autoCommit', true);
  services = createRuntimeServices({
    configManager,
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: repo,
    homeDirectory: root,
  });
  services.providerRegistry.registerRuntimeProvider({
    provider: scriptedProvider(),
    models: [{
      id: MODEL, provider: PROVIDER, registryKey: `${PROVIDER}:${MODEL}`, displayName: MODEL, description: 'scripted',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
      contextWindow: 200_000, selectable: true, tier: 'standard',
    } as unknown as ModelDefinition],
    replace: true,
  });
  services.providerRegistry.setCurrentModel(`${PROVIDER}:${MODEL}`);

  const owner = services.agentManager.spawn({ mode: 'spawn', task: TASK, template: 'engineer' } as never);
  const deadline = Date.now() + CHAIN_DEADLINE_MS;
  for (;;) {
    chain = services.wrfcController.listChains().find((c) => c.ownerAgentId === owner.id);
    if (chain?.state === 'fixing') sawFixing = true;
    if (chain && (chain.state === 'passed' || chain.state === 'failed')) break;
    if (Date.now() > deadline) break;
    await Bun.sleep(20);
  }
}, CHAIN_DEADLINE_MS + 10_000);

afterAll(() => {
  services?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('a failing review sends the chain into the fix phase, run by the real engine', () => {
  expect(played.slice(0, 3)).toEqual(['engineer', 'chain-review-1', 'fix-engineer']);
  expect(played).toContain('item-review');
  expect(sawFixing).toBe(true);
  expect(chain?.fixAttempts).toBe(1);
});

test('the re-review of the merged fix passes the chain', () => {
  expect(played[played.length - 1]).toBe('chain-review-2');
  expect(chain?.state).toBe('passed');
});

test('the fix is merged back onto the user\'s branch as a commit', () => {
  expect(readFileSync(join(repo, 'src', 'math.ts'), 'utf8')).toBe(FIXED);
  expect(git(repo, ['show', 'HEAD:src/math.ts'])).toBe(FIXED);
  expect(Number(git(repo, ['rev-list', '--count', 'HEAD']).trim())).toBeGreaterThan(1);
  expect(git(repo, ['status', '--porcelain', '--', 'src/math.ts']).trim()).toBe('');
});
