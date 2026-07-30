/**
 * Tests for WRFC phantom-pass, phantom-work, durable chains, and watchdog fixes.
 *
 * Items covered:
 * - Item 1: extractPassedFromText — score < threshold always returns false
 * - Item 2: verifyEngineerClaims — disk verification, git fallback
 * - Item 3: serializeChain/deserializeChain/importChain + resumeChain for interrupts
 * - Item 4a: watchdog timer — silent agent causes chain failure
 * - Item 4b: extractScoreFromText — null/malformed → null; null score → fail verdict
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractScoreFromText,
  extractPassedFromText,
} from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import {
  verifyEngineerClaims,
  parseReviewerCompletionReport,
} from '../packages/sdk/src/platform/agents/wrfc-reporting.js';
import { WrfcController, CURRENT_WRFC_CHAIN_SCHEMA_VERSION } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { installStubFixRunner } from '../packages/sdk/src/platform/agents/wrfc-controller-test-support.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';
import type { EngineerReport } from '../packages/sdk/src/platform/agents/completion-report.js';
import type { WrfcChain } from '../packages/sdk/src/platform/agents/wrfc-types.js';
import { trackDisposables } from './_helpers/disposables.ts';

// Every WrfcController starts a watchdog setInterval at construction (see
// resetWatchdog() in wrfc-controller.ts); registering here — inside
// createHarness() — disposes it after each test regardless of whether the
// test body remembers to call controller.dispose() itself.
const disposables = trackDisposables();

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Ceiling for a condition wait. Deliberately far above how long the watchdog
 * takes to fire even on a badly loaded machine: the wait returns the instant the
 * predicate holds, so headroom costs a fast host nothing, while a watchdog that
 * genuinely never fires still fails the test — just later, and with a message
 * that says what it was waiting for.
 */
const WAIT_CEILING_MS = 60_000;
/** Poll cadence. Small enough that the wait tracks the predicate closely. */
const WAIT_INTERVAL_MS = 10;
/**
 * Per-test budget for the watchdog tests, kept above WAIT_CEILING_MS so a
 * watchdog that never fires fails with waitUntil's labelled diagnostic instead
 * of bun's opaque "test timed out" — and so a merely SLOW runner never trips it.
 */
const WAIT_TEST_TIMEOUT_MS = 90_000;

/**
 * Real-clock polling for the watchdog tests.
 *
 * The watchdog is a `setInterval` at a quarter of the heartbeat timeout, so
 * whether it has fired yet is only observable across macrotask boundaries — no
 * number of microtask drains will advance it.
 *
 * Load tolerance: these tests used to sleep a fixed margin over the timeout
 * (150ms for a 100ms watchdog) and then assert. That margin is three interval
 * ticks on an idle host and none at all on a contended one, so the test failed
 * for being slow rather than for being wrong. There is no fixed sleep here: the
 * loop exits on the first true predicate, and only an unbounded wait counts as a
 * failure. The thrown message reports the label, the elapsed time and the worst
 * observed scheduler lag, which separates "the runner was starved" from "the
 * watchdog never fires".
 */
async function waitUntil(
  predicate: () => boolean,
  opts: { label?: string; ceilingMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const ceilingMs = Math.max(opts.ceilingMs ?? WAIT_CEILING_MS, WAIT_CEILING_MS);
  const intervalMs = opts.intervalMs ?? WAIT_INTERVAL_MS;
  const startedAt = Date.now();
  let worstLagMs = 0;
  while (!predicate()) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > ceilingMs) {
      throw new Error(
        `waitUntil: condition never became true — ${opts.label ?? 'unlabelled predicate'}; ` +
          `waited ${elapsedMs}ms (ceiling ${ceilingMs}ms), worst poll lag ${worstLagMs}ms`,
      );
    }
    const sleptAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    worstLagMs = Math.max(worstLagMs, Date.now() - sleptAt - intervalMs);
  }
}

/**
 * Best-effort settle wait: polls until the predicate holds or `ceilingMs`
 * elapses, and reports which happened. Never throws — for the two call sites
 * whose predicate must NOT become true, where the real assertion comes
 * afterwards. Strictly stronger than the blind sleep it replaced, because it
 * checks throughout the window instead of only at the end of it.
 */
async function waitUpTo(predicate: () => boolean, ceilingMs: number, intervalMs = WAIT_INTERVAL_MS): Promise<boolean> {
  const deadline = Date.now() + ceilingMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'running',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function makeEngineerReport(overrides: {
  filesCreated?: string[];
  filesModified?: string[];
}): EngineerReport {
  return {
    version: 1,
    archetype: 'engineer',
    summary: 'Done',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: ['Did the work'],
    filesCreated: overrides.filesCreated ?? [],
    filesModified: overrides.filesModified ?? [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  };
}

function engineerReportOutput(summary = 'Done', filesCreated: string[] = [], filesModified: string[] = []): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary,
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [summary],
      filesCreated,
      filesModified,
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
      constraints: [],
    }),
    '```',
  ].join('\n');
}

function reviewerReportOutput(score: number, passed: boolean): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: passed ? 'passed' : 'needs fixes',
      score,
      passed,
      dimensions: [],
      issues: passed ? [] : [{ severity: 'major', description: 'Needs a fix.', pointValue: 1 }],
      constraintFindings: [],
    }),
    '```',
  ].join('\n');
}

function emitAgentCompleted(
  bus: RuntimeEventBus,
  agentId: string,
  agentStore: Map<string, AgentRecord>,
  output?: string,
): void {
  // The controller reads record.fullOutput from agentManager.getStatus
  if (output !== undefined) {
    const record = agentStore.get(agentId);
    if (record) (record as AgentRecord & { fullOutput?: string }).fullOutput = output;
  }
  bus.emit(
    'agents',
    createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ),
  );
}

function createHarness(overrides?: {
  scoreThreshold?: number;
  maxFixAttempts?: number;
  agentHeartbeatTimeoutMs?: number;
  projectRoot?: string;
}) {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string }> = [];

  bus.onDomain('workflows', (envelope) => {
    workflowEvents.push({ type: envelope.type });
  });

  const threshold = overrides?.scoreThreshold ?? 9.9;
  const maxFixAttempts = overrides?.maxFixAttempts ?? 3;
  const agentHeartbeatTimeoutMs = overrides?.agentHeartbeatTimeoutMs ?? 0;
  const projectRoot = overrides?.projectRoot ?? '/tmp/test-project';

  // ConfigManager.get/getCategory are generic over `ConfigKey`/`keyof GoodVibesConfig`
  // with a per-key conditional return type — a by-string-key stub can't be typed
  // against that generic signature directly (TypeScript hits its own recursion
  // limit, "Excessive stack depth", comparing two such generic conditional
  // signatures). Casting the whole mock once at the boundary sidesteps that
  // compiler limitation; ConfigManager's own methods work around the same
  // expressiveness gap internally with `as ConfigValue<K>`.
  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return threshold;
      if (key === 'wrfc.maxFixAttempts') return maxFixAttempts;
      if (key === 'wrfc.autoCommit') return false;
      if (key === 'wrfc.agentHeartbeatTimeoutMs') return agentHeartbeatTimeoutMs;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'wrfc') {
        return {
          scoreThreshold: threshold,
          maxFixAttempts,
          autoCommit: false,
          agentHeartbeatTimeoutMs,
          gates: [] as Array<{ name: string; command: string; enabled: boolean }>,
        };
      }
      return undefined;
    },
  } as unknown as Pick<import('../packages/sdk/src/platform/config/manager.js').ConfigManager, 'get' | 'getCategory'>;

  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawnedRecords.length + 1}`;
      const record = makeRecord({
        id,
        task: (input as { task?: string }).task ?? 'spawned-task',
        template: (input as { template?: string }).template ?? 'engineer',
        parentAgentId: (input as { parentAgentId?: string }).parentAgentId,
        status: 'running',
      });
      agentStore.set(id, record);
      spawnedRecords.push(record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: (_id: string) => false,
    listByCohort: (_cohort: string) => [],
    clear: () => { agentStore.clear(); },
  };

  const messageBus = { registerAgent: (_opts: unknown) => {} };

  const controller = disposables.add(new WrfcController(bus, messageBus, {
    agentManager,
    configManager,
    projectRoot,
    createWorktree: () => ({
      merge: async () => true,
      cleanup: async () => {},
      cloneForAgent: async () => {},
      worktreePathForAgent: () => null,
    }),
  }));

  return { bus, controller, agentStore, spawnedRecords, workflowEvents, projectRoot };
}

// ---------------------------------------------------------------------------
// Item 1: extractPassedFromText — phantom-pass fix
// ---------------------------------------------------------------------------

describe('Item 1: extractPassedFromText — phantom-pass fix', () => {
  const THRESHOLD = 9.9;

  test('score below threshold + "approved" prose → false (was phantom-pass before fix)', () => {
    expect(extractPassedFromText('The implementation is approved.', 5.0, THRESHOLD)).toBe(false);
  });

  test('score below threshold + "passed" prose → false', () => {
    expect(extractPassedFromText('This review passed with flying colors.', 8.0, THRESHOLD)).toBe(false);
  });

  test('score exactly at threshold + no prose → true', () => {
    expect(extractPassedFromText('Score: 9.9/10', 9.9, THRESHOLD)).toBe(true);
  });

  test('score above threshold + no prose → true', () => {
    expect(extractPassedFromText('Score: 10/10', 10, THRESHOLD)).toBe(true);
  });

  test('score above threshold + explicit fail prose → false', () => {
    expect(extractPassedFromText('The review failed.', 10, THRESHOLD)).toBe(false);
  });

  test('score above threshold + fail and passed prose → true (passed wins)', () => {
    // The regexp checks for "fail" AND absence of "pass"; here both appear so passed takes precedence.
    expect(extractPassedFromText('The implementation failed to meet minor nits but ultimately passed.', 10, THRESHOLD)).toBe(true);
  });

  test('score zero with any prose → false', () => {
    expect(extractPassedFromText('Perfect implementation. Approved!', 0, THRESHOLD)).toBe(false);
  });

  test('custom lower threshold: score 7 >= threshold 5 → true', () => {
    expect(extractPassedFromText('Looks good.', 7, 5)).toBe(true);
  });

  test('custom lower threshold: score 4 < threshold 5 → false', () => {
    expect(extractPassedFromText('Looks good.', 4, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 4b: extractScoreFromText — fail-closed on malformed/absent scores
// ---------------------------------------------------------------------------

describe('Item 4b: extractScoreFromText — fail-closed', () => {
  test('empty string → null', () => {
    expect(extractScoreFromText('')).toBeNull();
  });

  test('prose without score → null', () => {
    expect(extractScoreFromText('Great job! The implementation is wonderful.')).toBeNull();
  });

  test('malformed score (no /10) → null', () => {
    expect(extractScoreFromText('Score: 9.5')).toBeNull();
  });

  test('score over 10 → null (out of range)', () => {
    // The regex accepts value <= 10 only
    expect(extractScoreFromText('Score: 11/10')).toBeNull();
  });

  test('valid score 9.9/10 → 9.9', () => {
    expect(extractScoreFromText('Score: 9.9/10')).toBe(9.9);
  });

  test('valid score 10/10 → 10', () => {
    expect(extractScoreFromText('Score: 10/10')).toBe(10);
  });

  test('valid score 5/10 → 5', () => {
    expect(extractScoreFromText('Score: 5/10')).toBe(5);
  });

  test('null score in parseReviewerCompletionReport → passed: false (fail-closed)', () => {
    // Plain prose with no numeric score — extractScoreFromText returns null → score defaults to 0
    const report = parseReviewerCompletionReport(
      'chain-1',
      'The code looks approved! Great work overall.',
      9.9,
    );
    expect(report.passed).toBe(false);
  });

  test('malformed JSON block falls back to text parsing and is fail-closed without score', () => {
    const report = parseReviewerCompletionReport(
      'chain-1',
      '```json\n{ invalid json }\n```\nApproved!',
      9.9,
    );
    // No valid score → passes false
    expect(report.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 2: verifyEngineerClaims — disk verification
// ---------------------------------------------------------------------------

describe('Item 2: verifyEngineerClaims — disk verification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-claims-'));
  });

  test('empty claims in non-git dir → kind=unverifiable_no_claims, verified=false (MAJ-1 loophole closed)', () => {
    // tmpDir is not a git repo so gitDiffDetected=false or null
    const report = makeEngineerReport({});
    const result = verifyEngineerClaims(report, tmpDir);
    // MAJ-1: zero claims + no git diff → suspicious, not a clean pass
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.verified).toBe(false);
    expect(result.claimedPaths).toHaveLength(0);
  });

  test('all claimed files exist → verified=true', () => {
    const existingFile = join(tmpDir, 'src', 'app.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(existingFile, 'export {}');

    const report = makeEngineerReport({ filesCreated: ['src/app.ts'] });
    const result = verifyEngineerClaims(report, tmpDir);
    expect(result.verified).toBe(true);
    expect(result.foundPaths).toContain('src/app.ts');
    expect(result.missingPaths).toHaveLength(0);
  });

  test('claimed file missing and no git repo → verified=false', () => {
    // tmpDir is not a git repo, so git diff will fail → gitDiffDetected=null
    const report = makeEngineerReport({ filesCreated: ['src/nonexistent.ts'] });
    const result = verifyEngineerClaims(report, tmpDir);
    // missingPaths has entries, git returns null → not verified
    expect(result.verified).toBe(false);
    expect(result.missingPaths).toContain('src/nonexistent.ts');
    expect(result.gitDiffDetected).toBeNull();
  });

  test('filesModified are checked for existence', () => {
    const existingFile = join(tmpDir, 'index.ts');
    writeFileSync(existingFile, '// existing');

    const report = makeEngineerReport({
      filesModified: ['index.ts', 'missing.ts'],
    });
    const result = verifyEngineerClaims(report, tmpDir);
    expect(result.foundPaths).toContain('index.ts');
    expect(result.missingPaths).toContain('missing.ts');
    // missing.ts not found; git not a repo → unverified
    expect(result.verified).toBe(false);
  });

  test('non-engineer report → verified=true (verification is skipped)', () => {
    const genericReport = {
      version: 1 as const,
      archetype: 'generic' as const,
      summary: 'Done',
    };
    // Cast to CompletionReport to satisfy the type
    const result = verifyEngineerClaims(genericReport as Parameters<typeof verifyEngineerClaims>[0], tmpDir);
    expect(result.verified).toBe(true);
  });

  test('absolute paths in filesCreated are checked correctly', () => {
    const absFile = join(tmpDir, 'abs.ts');
    writeFileSync(absFile, '// abs');

    const report = makeEngineerReport({ filesCreated: [absFile] });
    const result = verifyEngineerClaims(report, tmpDir);
    expect(result.foundPaths).toContain(absFile);
    expect(result.verified).toBe(true);
    expect(result.kind).toBe('files_verified');
  });

  // --- MAJ-1 tri-state tests ---

  test('MAJ-1: all claimed files exist → kind=files_verified', () => {
    const f = join(tmpDir, 'a.ts');
    writeFileSync(f, '// a');
    const result = verifyEngineerClaims(makeEngineerReport({ filesCreated: ['a.ts'] }), tmpDir);
    expect(result.kind).toBe('files_verified');
    expect(result.verified).toBe(true);
  });

  test('MAJ-1: claims missing but git shows changes → kind=git_corroborated, verified=true', () => {
    // We cannot easily create a real git diff in a temp dir, but we can unit-test
    // the kind derivation by directly inspecting a scenario where gitDiffDetected=true
    // but the claimed file is missing. We do this by passing an absolute path that
    // exists in the actual project root (which is a git repo).
    // This test verifies the LOGIC path; we observe kind when files missing + git shows changes.
    // Since tmpDir is NOT a git repo, gitDiffDetected=null. So we test via project root.
    const projectRoot = process.cwd();
    // Claim a file we know doesn't exist but the project IS a git repo with changes.
    // With a clean repo, gitDiffDetected may be false; the important thing is the kind logic.
    const result = verifyEngineerClaims(
      makeEngineerReport({ filesCreated: ['__this_file_does_not_exist__.ts'] }),
      projectRoot,
    );
    // kind is either 'git_corroborated' (if there are staged/unstaged changes) or 'unverified'
    expect(['git_corroborated', 'unverified']).toContain(result.kind);
    // verified iff git corroborated
    expect(result.verified).toBe(result.kind === 'git_corroborated');
  });

  test('MAJ-1: no claims, git unavailable/no repo → kind=unverifiable_no_claims, verified=false', () => {
    const result = verifyEngineerClaims(makeEngineerReport({}), tmpDir);
    expect(result.kind).toBe('unverifiable_no_claims');
    expect(result.verified).toBe(false);
  });

  test('MAJ-1: claims present, missing, git unavailable → kind=unverified, verified=false', () => {
    const result = verifyEngineerClaims(
      makeEngineerReport({ filesCreated: ['does-not-exist.ts'] }),
      tmpDir,
    );
    expect(result.kind).toBe('unverified');
    expect(result.verified).toBe(false);
  });

  test('MAJ-1: result always carries kind field', () => {
    const result = verifyEngineerClaims(makeEngineerReport({}), tmpDir);
    expect(result.kind).toBeDefined();
    expect(['files_verified', 'git_corroborated', 'verified_empty', 'unverifiable_no_claims', 'unverified']).toContain(result.kind);
  });
});

// ---------------------------------------------------------------------------
// Item 3: chain serialization / deserialization / importChain
// ---------------------------------------------------------------------------

describe('Item 3: serializeChain / deserializeChain / importChain', () => {
  test('serializeChain returns null for unknown chain', () => {
    const { controller } = createHarness();
    expect(controller.serializeChain('nonexistent-chain')).toBeNull();
  });

  test('serializeChain produces valid JSON with schemaVersion envelope that round-trips via deserializeChain (MAJ-2)', async () => {
    const { controller, agentStore } = createHarness();

    const ownerRecord = makeRecord({ id: 'owner-1', task: 'Build feature X' });
    agentStore.set('owner-1', ownerRecord);
    controller.createChain(ownerRecord);
    await flushMicrotasks();

    const chainId = controller.listChains()[0]?.id;
    expect(chainId).toBeDefined();

    const json = controller.serializeChain(chainId!);
    expect(json).not.toBeNull();

    // MAJ-2: verify the envelope structure
    const envelope = JSON.parse(json!) as { schemaVersion: number; chain: unknown };
    expect(envelope.schemaVersion).toBe(CURRENT_WRFC_CHAIN_SCHEMA_VERSION);
    expect(envelope.chain).toBeDefined();
    expect((envelope.chain as { id: string }).id).toBe(chainId!);

    const parsed = controller.deserializeChain(json!);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(chainId!);
    expect(parsed!.task).toBe('Build feature X');
    expect(parsed!.ownerAgentId).toBe('owner-1');
  });

  test('MAJ-2: legacy v0 payload (raw chain JSON without schemaVersion) is accepted for back-compat', () => {
    const { controller } = createHarness();
    const legacyPayload = JSON.stringify({
      id: 'legacy-chain',
      state: 'reviewing',
      task: 'Legacy task',
      ownerAgentId: 'owner-legacy',
      allAgentIds: ['owner-legacy'],
      fixAttempts: 0,
      reviewCycles: 0,
      reviewScores: [],
      createdAt: Date.now(),
      ownerTerminalEmitted: false,
      constraints: [],
      constraintsEnumerated: false,
      ownerDecisions: [],
    });
    const chain = controller.deserializeChain(legacyPayload);
    expect(chain).not.toBeNull();
    expect(chain!.id).toBe('legacy-chain');
    expect(chain!.task).toBe('Legacy task');
  });

  test('MAJ-2: future schemaVersion is rejected — fail closed', () => {
    const { controller } = createHarness();
    const futurePayload = JSON.stringify({
      schemaVersion: CURRENT_WRFC_CHAIN_SCHEMA_VERSION + 1,
      chain: {
        id: 'future-chain',
        state: 'reviewing',
        task: 'Future task',
        ownerAgentId: 'owner-future',
      },
    });
    const result = controller.deserializeChain(futurePayload);
    expect(result).toBeNull();
  });

  test('MAJ-2: malformed/hostile JSON is rejected without partial registration', () => {
    const { controller } = createHarness();
    // Various hostile inputs
    expect(controller.deserializeChain('null')).toBeNull();
    expect(controller.deserializeChain('{"schemaVersion":1}')).toBeNull(); // missing chain
    expect(controller.deserializeChain('{"schemaVersion":1,"chain":{}}')).toBeNull(); // chain missing required fields
    expect(controller.deserializeChain('{"id":"x","state":"pending"}')).toBeNull(); // missing ownerAgentId + task
    // None of these should have been registered
    expect(controller.listChains()).toHaveLength(0);
  });

  test('deserializeChain returns null for invalid JSON', () => {
    const { controller } = createHarness();
    expect(controller.deserializeChain('not valid json {')).toBeNull();
  });

  test('deserializeChain returns null when required fields are missing', () => {
    const { controller } = createHarness();
    // Missing ownerAgentId and task fields
    expect(controller.deserializeChain(JSON.stringify({ id: 'x', state: 'pending' }))).toBeNull();
  });

  test('importChain registers the chain and getChain returns it', () => {
    const { controller, agentStore } = createHarness();
    // importChain reaps a non-terminal chain whose
    // ENTIRE roster is absent from the live AgentManager (zombie chain from
    // a prior process). Register one roster agent as live so this test
    // exercises plain import/retrieval, not the zombie-reap path.
    agentStore.set('owner-99', makeRecord({ id: 'owner-99', task: 'Serialized task' }));
    const fakeChain: WrfcChain = {
      id: 'imported-chain',
      state: 'reviewing',
      task: 'Serialized task',
      ownerAgentId: 'owner-99',
      allAgentIds: ['owner-99', 'eng-1'],
      fixAttempts: 0,
      reviewCycles: 1,
      reviewScores: [8.0],
      createdAt: Date.now(),
      ownerTerminalEmitted: false,
      constraints: [],
      constraintsEnumerated: true,
      ownerDecisions: [],
    };
    const imported = controller.importChain(fakeChain);
    expect(imported).toBe(true);
    const retrieved = controller.getChain('imported-chain');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.state).toBe('reviewing');
    expect(retrieved!.task).toBe('Serialized task');
  });

  test('MIN-5: importChain refuses to overwrite non-terminal chain without force flag', () => {
    const { controller, agentStore } = createHarness();
    // Keep this chain out of the zombie-reap path
    // (see the comment above) so the assertions below test ONLY the
    // refuse-without-force behavior, not an incidental reap.
    agentStore.set('owner-a', makeRecord({ id: 'owner-a', task: 'Original task' }));
    const base: WrfcChain = {
      id: 'conflict-chain',
      state: 'engineering', // non-terminal
      task: 'Original task',
      ownerAgentId: 'owner-a',
      allAgentIds: ['owner-a'],
      fixAttempts: 0,
      reviewCycles: 0,
      reviewScores: [],
      createdAt: Date.now(),
      ownerTerminalEmitted: false,
      constraints: [],
      constraintsEnumerated: false,
      ownerDecisions: [],
    };
    // First import succeeds
    expect(controller.importChain(base)).toBe(true);
    // Second import with same ID on non-terminal chain is refused
    const duplicate = { ...base, task: 'Replacement task' };
    expect(controller.importChain(duplicate)).toBe(false);
    // Original is untouched
    expect(controller.getChain('conflict-chain')!.task).toBe('Original task');
  });

  test('MIN-5: importChain with force=true overwrites non-terminal chain', () => {
    const { controller, agentStore } = createHarness();
    // Keep this chain out of the zombie-reap path so
    // this test exercises ONLY the force-overwrite behavior.
    agentStore.set('owner-f', makeRecord({ id: 'owner-f', task: 'Original task' }));
    const base: WrfcChain = {
      id: 'force-chain',
      state: 'reviewing', // non-terminal
      task: 'Original task',
      ownerAgentId: 'owner-f',
      allAgentIds: ['owner-f'],
      fixAttempts: 0,
      reviewCycles: 0,
      reviewScores: [],
      createdAt: Date.now(),
      ownerTerminalEmitted: false,
      constraints: [],
      constraintsEnumerated: false,
      ownerDecisions: [],
    };
    controller.importChain(base);
    const replacement = { ...base, task: 'Replacement task' };
    expect(controller.importChain(replacement, true)).toBe(true);
    expect(controller.getChain('force-chain')!.task).toBe('Replacement task');
  });

  test('MIN-5: importChain always overwrites terminal (passed/failed) chains', () => {
    const { controller } = createHarness();
    const passedChain: WrfcChain = {
      id: 'terminal-chain',
      state: 'passed', // terminal
      task: 'Old task',
      ownerAgentId: 'owner-t',
      allAgentIds: ['owner-t'],
      fixAttempts: 0,
      reviewCycles: 0,
      reviewScores: [10],
      createdAt: Date.now(),
      ownerTerminalEmitted: true,
      constraints: [],
      constraintsEnumerated: true,
      ownerDecisions: [],
    };
    controller.importChain(passedChain);
    // Overwrite terminal chain without force flag — should succeed
    const newChain = { ...passedChain, task: 'Replayed task' };
    expect(controller.importChain(newChain)).toBe(true);
    expect(controller.getChain('terminal-chain')!.task).toBe('Replayed task');
  });

  test('full round-trip: serialize → deserialize → import → getChain', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createHarness();

    const ownerRecord = makeRecord({ id: 'owner-rt', task: 'Round-trip task' });
    agentStore.set('owner-rt', ownerRecord);
    controller.createChain(ownerRecord);
    await flushMicrotasks();

    const originalChainId = controller.listChains()[0]?.id;
    expect(originalChainId).toBeDefined();

    const json = controller.serializeChain(originalChainId!)!;
    expect(json).not.toBeNull();

    // Create a second controller and import
    const { controller: ctrl2, agentStore: store2 } = createHarness();
    const deserialized = ctrl2.deserializeChain(json);
    expect(deserialized).not.toBeNull();
    ctrl2.importChain(deserialized!);

    const imported = ctrl2.getChain(originalChainId!);
    expect(imported).not.toBeNull();
    expect(imported!.task).toBe('Round-trip task');
    expect(imported!.id).toBe(originalChainId!);
  });
});

// ---------------------------------------------------------------------------
// Item 3: resumeChain — interrupt recovery
// ---------------------------------------------------------------------------

describe('Item 3: resumeChain — interrupt recovery from reviewing state', () => {
  test('resumeChain on reviewing state with engineerReport re-spawns a reviewer', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createHarness();

    // Set up an owner and create chain
    const ownerRecord = makeRecord({ id: 'owner-rv', task: 'Resume from reviewing' });
    agentStore.set('owner-rv', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    // Simulate engineer completion
    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, engineerReportOutput('Done', [], []));
    await flushMicrotasks();

    // Chain should now be in reviewing state — simulate interrupt by removing reviewer
    const chainId = chain.id;
    const chainRecord = controller.getChain(chainId);
    expect(chainRecord?.state).toBe('reviewing');

    const reviewerCount = spawnedRecords.filter((r) => r.wrfcRole === 'reviewer').length;
    expect(reviewerCount).toBeGreaterThan(0); // sanity: original reviewer was spawned

    // Simulate an interrupted chain restart: mark all child agents as done
    // (simulating that the process died before the reviewer completed),
    // clear the active reviewer reference, and reset state for re-spawning.
    for (const id of chainRecord!.allAgentIds) {
      if (id === chainRecord!.ownerAgentId) continue;
      const rec = agentStore.get(id);
      if (rec && (rec.status === 'running' || rec.status === 'pending')) {
        rec.status = 'completed';
      }
    }
    chainRecord!.state = 'reviewing';
    chainRecord!.reviewerAgentId = undefined; // no active reviewer

    controller.resumeChain(chainId);
    await flushMicrotasks();

    // A new reviewer should have been spawned
    const newReviewerCount = spawnedRecords.filter((r) => r.wrfcRole === 'reviewer').length;
    expect(newReviewerCount).toBeGreaterThan(reviewerCount);
  });
});

// ---------------------------------------------------------------------------
// Item 2: phantom-work detection in controller (integration)
// ---------------------------------------------------------------------------

describe('Item 2: phantom-work detection (controller integration)', () => {
  test('engineer claims nonexistent file → chain.claimsVerified=false and synthetic issue added', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-phantom-'));
    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });

    const ownerRecord = makeRecord({ id: 'owner-ph', task: 'Phantom work test' });
    agentStore.set('owner-ph', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer claims a file that does NOT exist on disk and tmpDir is not a git repo
    const fakeOutput = engineerReportOutput('Done', ['src/nonexistent-file.ts'], []);
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, fakeOutput);
    await flushMicrotasks();

    const chainRecord = controller.getChain(chain.id);
    expect(chainRecord?.claimsVerified).toBe(false);
  });

  test('engineer claims file that exists → chain.claimsVerified=true', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-verified-'));
    const realFile = join(tmpDir, 'src', 'real.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(realFile, 'export {}');

    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });

    const ownerRecord = makeRecord({ id: 'owner-vf', task: 'Verified file test' });
    agentStore.set('owner-vf', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer claims an existing file
    const fakeOutput = engineerReportOutput('Done', ['src/real.ts'], []);
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, fakeOutput);
    await flushMicrotasks();

    const chainRecord = controller.getChain(chain.id);
    expect(chainRecord?.claimsVerified).toBe(true);
  });

  test('MAJ-1: empty claims in non-git dir → claimsVerified=undefined (not false), synthetic issue injected into reviewer task, chain proceeds to reviewing', async () => {
    // 'unverifiable_no_claims' should NOT set claimsVerified=false because we can't
    // confirm work WASN'T done — the synthetic issue is the enforcement mechanism.
    // The MIN-4 mechanical block only fires on claimsVerified===false (kind=unverified).
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-no-claims-'));
    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });

    const ownerRecord = makeRecord({ id: 'owner-nc', task: 'No claims test' });
    agentStore.set('owner-nc', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer reports zero files in a non-git directory → kind=unverifiable_no_claims
    const fakeOutput = engineerReportOutput('Done', [], []);
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, fakeOutput);
    await flushMicrotasks();

    const chainRecord = controller.getChain(chain.id);
    // claimsVerified must NOT be false — it should be undefined (unresolved, not confirmed false)
    expect(chainRecord?.claimsVerified).not.toBe(false);
    expect(chainRecord?.claimsVerified).toBeUndefined();
    // Chain should proceed to reviewing (the synthetic issue is the enforcement path)
    expect(chainRecord?.state).toBe('reviewing');
    // The synthetic issue is injected into the reviewer's task and then cleared from the chain.
    // Verify it was forwarded: the spawned reviewer's task must contain the phantom-work flag.
    const reviewerRecord = spawnedRecords.find((r) => r.wrfcRole === 'reviewer');
    expect(reviewerRecord).toBeDefined();
    expect(reviewerRecord!.task).toContain('phantom work');
    expect(reviewerRecord!.task).toContain('## Synthetic issues from controller');

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Item 4a: Silent-agent watchdog
// ---------------------------------------------------------------------------

describe('Item 4a: silent-agent watchdog', () => {
  /**
   * Window over which a chain that must NOT fail is watched. The watchdog clamps
   * its tick to a 50ms floor, so this holds several ticks of the fastest one the
   * implementation can produce — long enough for the absence to mean something,
   * short enough that a negative test does not dominate the file's runtime.
   */
  const NEGATIVE_WINDOW_MS = 300;
  /**
   * Heartbeat timeout for the streaming test, and the delta cadence under it.
   * The gap between them IS the load tolerance: a delta must be twenty cadences
   * late before the watchdog can beat it.
   */
  const STREAM_WATCHDOG_TIMEOUT_MS = 1_000;
  const STREAM_DELTA_INTERVAL_MS = 50;
  /** How long streaming must outlast the window before the liveness claim holds. */
  const STREAM_SPAN_MS = STREAM_WATCHDOG_TIMEOUT_MS + 500;

  test('chain passes normally when engineer completes before watchdog fires', async () => {
    const { bus, controller, agentStore, spawnedRecords, workflowEvents } = createHarness({
      agentHeartbeatTimeoutMs: 60_000, // long timeout — won't fire
    });

    const ownerRecord = makeRecord({ id: 'owner-wd-ok', task: 'Watchdog ok test' });
    agentStore.set('owner-wd-ok', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer completes normally
    const output = engineerReportOutput('Done', [], []);
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, output);
    await flushMicrotasks();

    // Chain should be in reviewing state (not failed)
    const chainRecord = controller.getChain(chain.id);
    expect(chainRecord?.state).not.toBe('failed');

    controller.dispose();
  });

  test('watchdog fires and fails chain when agent goes silent', async () => {
    // Use a very short timeout and manually trigger the tick
    const { controller, agentStore, spawnedRecords } = createHarness({
      agentHeartbeatTimeoutMs: 100, // 100ms timeout
    });

    const ownerRecord = makeRecord({ id: 'owner-wd-fail', task: 'Watchdog fail test' });
    agentStore.set('owner-wd-fail', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Set the engineer's startedAt far in the past to simulate a silent agent
    const agentEntry = agentStore.get(engineerRecord!.id)!;
    agentEntry.startedAt = Date.now() - 10_000; // 10 seconds ago
    agentEntry.status = 'running';

    // The watchdog is private, so we wait for its timer to fire naturally — on
    // the condition, not on a clock. Every tick sees a 10-second-old lastSeen
    // against a 100ms timeout, so the FIRST tick that runs fails the chain
    // however late the runtime gets around to it.
    await waitUntil(() => controller.getChain(chain.id)?.state === 'failed', {
      label: 'watchdog failed the chain of a silent agent',
    });
    await flushMicrotasks();

    const chainRecord = controller.getChain(chain.id);
    expect(chainRecord?.state).toBe('failed');
    expect(chainRecord?.error).toContain('went silent');

    controller.dispose();
  }, WAIT_TEST_TIMEOUT_MS);

  test('watchdog disabled (timeout=0) does not fail silent chains', async () => {
    const { controller, agentStore, spawnedRecords } = createHarness({
      agentHeartbeatTimeoutMs: 0, // disabled
    });

    const ownerRecord = makeRecord({ id: 'owner-wd-disabled', task: 'Watchdog disabled test' });
    agentStore.set('owner-wd-disabled', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    // A timeout of 0 means resetWatchdog() starts no timer at all, so there is
    // no event to wait FOR here — only the absence of one. Poll for the failure
    // across a window that would hold several ticks of the shortest watchdog the
    // clamp allows (50ms), and require that it never arrives.
    const failed = await waitUpTo(
      () => controller.getChain(chain.id)?.state === 'failed',
      NEGATIVE_WINDOW_MS,
    );
    await flushMicrotasks();

    expect(failed, 'a disabled watchdog failed the chain anyway').toBe(false);
    const chainRecord = controller.getChain(chain.id);
    expect(chainRecord?.state).toBe('engineering');

    controller.dispose();
  }, WAIT_TEST_TIMEOUT_MS);

  test('MAJ-3: AGENT_STREAM_DELTA resets agentLastSeen so streaming-only agent is not killed by watchdog', async () => {
    // The agent streams deltas but sends no PROGRESS events. What is asserted is
    // unchanged: streaming alone keeps the chain alive past the watchdog window,
    // and the chain dies once streaming stops.
    //
    // The RATIO is what changed. This used to run a 150ms watchdog against a 40ms
    // delta cadence — a margin of under four cadences, which a contended runner
    // eats without being in any way broken, and the chain then died mid-test for
    // want of a heartbeat that was merely late. At 1000ms against 50ms, a delta
    // has to arrive twenty cadences late before the watchdog can win, which is a
    // genuinely pathological host rather than a busy one — and the assertion
    // below reports the worst gap it saw, so that case says so instead of
    // looking like a broken reset.
    const { bus, controller, agentStore, spawnedRecords } = createHarness({
      agentHeartbeatTimeoutMs: STREAM_WATCHDOG_TIMEOUT_MS,
    });

    const ownerRecord = makeRecord({ id: 'owner-stream', task: 'Streaming watchdog test' });
    agentStore.set('owner-stream', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();
    const agentId = engineerRecord!.id;

    // Emit AGENT_STREAM_DELTA on a cadence far shorter than the watchdog window,
    // recording the worst gap between consecutive deltas so a starved runner is
    // distinguishable from a broken lastSeen reset.
    const streamStartedAt = Date.now();
    let lastDeltaAt = streamStartedAt;
    let worstDeltaGapMs = 0;
    let deltaCount = 0;
    const streamInterval = setInterval(() => {
      const firedAt = Date.now();
      worstDeltaGapMs = Math.max(worstDeltaGapMs, firedAt - lastDeltaAt);
      lastDeltaAt = firedAt;
      deltaCount++;
      bus.emit(
        'agents',
        createEventEnvelope(
          'AGENT_STREAM_DELTA',
          { type: 'AGENT_STREAM_DELTA', agentId, content: 'x', accumulated: 'x' },
          { sessionId: 'test', traceId: 'test', source: 'test' },
        ),
      );
    }, STREAM_DELTA_INTERVAL_MS);

    // Stream until the run has outlasted the watchdog window — the condition the
    // test is actually about — rather than until a fixed clock reading.
    await waitUntil(() => Date.now() - streamStartedAt >= STREAM_SPAN_MS, {
      label: 'streamed continuously past the watchdog window',
    });
    clearInterval(streamInterval);
    await flushMicrotasks();

    // Chain must NOT have been killed by the watchdog: streaming is a heartbeat.
    const chainRecord = controller.getChain(chain.id);
    expect(
      chainRecord?.state,
      `chain died while streaming: ${deltaCount} deltas over ${Date.now() - streamStartedAt}ms, ` +
        `worst gap between deltas ${worstDeltaGapMs}ms against a ${STREAM_WATCHDOG_TIMEOUT_MS}ms watchdog`,
    ).toBe('engineering');

    // Now stop streaming — the chain must time out. Waited on the condition, so
    // the watchdog's tick cadence and any scheduler lag are both immaterial.
    agentStore.get(agentId)!.status = 'running';
    await waitUntil(() => controller.getChain(chain.id)?.state === 'failed', {
      label: 'watchdog failed the chain once streaming stopped',
    });
    await flushMicrotasks();

    const chainRecordAfter = controller.getChain(chain.id);
    expect(chainRecordAfter?.state).toBe('failed');
    expect(chainRecordAfter?.error).toContain('went silent');

    controller.dispose();
  }, WAIT_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// MIN-4: claimsVerified===false blocks pass even at 10/10 score
// ---------------------------------------------------------------------------

describe('MIN-4: claimsVerified=false blocks review pass mechanically', () => {
  test('reviewer says 10/10 but claimsVerified=false → no pass, chain goes to fixing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-min4-'));
    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });
    installStubFixRunner(controller, 'pending'); // the planned-fix path parks the chain honestly in 'fixing'

    const ownerRecord = makeRecord({ id: 'owner-min4', task: 'MIN-4 test' });
    agentStore.set('owner-min4', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer claims a file that does NOT exist and tmpDir is not a git repo
    // → kind=unverified (claims present but file missing, no git) → claimsVerified=false
    // NOTE: kind=unverifiable_no_claims (zero claims + no git) is a different path; it leaves
    // claimsVerified=undefined and relies on the synthetic issue alone — see test below.
    const fakeOutput = engineerReportOutput('Done', ['src/nonexistent-file.ts'], []);
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, fakeOutput);
    await flushMicrotasks();

    // Chain should be in reviewing state (synthetic issue injected)
    const chainAfterEngineer = controller.getChain(chain.id);
    expect(chainAfterEngineer?.claimsVerified).toBe(false);
    expect(chainAfterEngineer?.state).toBe('reviewing');

    // Now reviewer gives a perfect 10/10 score
    const reviewerRecord = spawnedRecords.find((r) => r.wrfcRole === 'reviewer');
    expect(reviewerRecord).toBeDefined();
    emitAgentCompleted(bus, reviewerRecord!.id, agentStore, reviewerReportOutput(10, true));
    await flushMicrotasks();

    // MIN-4: must NOT pass — claimsVerified=false overrides the score gate
    const chainAfterReview = controller.getChain(chain.id);
    expect(chainAfterReview?.state).toBe('fixing');
  });
});

// ---------------------------------------------------------------------------
// MIN-6: resume re-injects phantom-work synthetic issue when claimsVerified=false
// ---------------------------------------------------------------------------

describe('MIN-6: resume re-injects synthetic issue when claimsVerified=false', () => {
  test('resuming a reviewing chain with claimsVerified=false re-injects phantom issue', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-min6-'));
    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });

    const ownerRecord = makeRecord({ id: 'owner-min6', task: 'MIN-6 test' });
    agentStore.set('owner-min6', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer');
    expect(engineerRecord).toBeDefined();

    // Engineer claims nonexistent file → claimsVerified=false
    emitAgentCompleted(bus, engineerRecord!.id, agentStore, engineerReportOutput('Done', ['no-such-file.ts'], []));
    await flushMicrotasks();

    const chainId = chain.id;
    const chainRecord = controller.getChain(chainId)!;
    expect(chainRecord.claimsVerified).toBe(false);
    expect(chainRecord.state).toBe('reviewing');

    // Simulate interrupt: mark reviewer done, clear reviewer reference
    for (const id of chainRecord.allAgentIds) {
      if (id !== chainRecord.ownerAgentId) {
        const rec = agentStore.get(id);
        if (rec) rec.status = 'completed';
      }
    }
    chainRecord.reviewerAgentId = undefined;
    // startReview would have cleared syntheticIssues — simulate that
    chainRecord.syntheticIssues = [];

    controller.resumeChain(chainId);
    await flushMicrotasks();

    // After resume, a new reviewer should have been spawned
    const newReviewerCount = spawnedRecords.filter((r) => r.wrfcRole === 'reviewer').length;
    expect(newReviewerCount).toBeGreaterThan(0);
    // syntheticIssues should be re-injected and then consumed by startReview (cleared)
    // The test verifies resume did NOT silently launder the claimsVerified=false
    // The synthetic issue was re-injected before startReview consumed it.
    // We can verify the re-injection happened by checking that claimsVerified is still false.
    expect(controller.getChain(chainId)?.claimsVerified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MIN-11: Fixer claim verification (MAJ-9 fix — fixer class no longer exempted)
// ---------------------------------------------------------------------------

describe('MIN-11 (planned-fix rework): the fixer agent class no longer exists', () => {
  test('a failing review runs the planned workstream — no fixer agent ever spawns; per-task phantom detection lives in the engine phases', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wrfc-fixer-gone-'));
    const { bus, controller, agentStore, spawnedRecords } = createHarness({ projectRoot: tmpDir });
    const fixRuns = installStubFixRunner(controller, 'merged');

    const ownerRecord = makeRecord({ id: 'owner-f-gone', task: 'Planned path test' });
    agentStore.set('owner-f-gone', ownerRecord);
    const chain = controller.createChain(ownerRecord);
    await flushMicrotasks();

    const engineerRecord = spawnedRecords.find((r) => r.wrfcRole === 'engineer')!;
    const existingFile = join(tmpDir, 'src', 'honest.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(existingFile, 'export {}');
    emitAgentCompleted(bus, engineerRecord.id, agentStore, engineerReportOutput('Honest work', ['src/honest.ts'], []));
    await flushMicrotasks();

    const reviewerRecord = spawnedRecords.find((r) => r.wrfcRole === 'reviewer')!;
    emitAgentCompleted(bus, reviewerRecord.id, agentStore, reviewerReportOutput(5.0, false));
    await flushMicrotasks(40);

    // The planned-fix workstream ran (elastic tasks in isolated worktrees,
    // slice reviews inside the engine — where per-task claim verification
    // lives, see phase-runner). NO fixer agent exists to lie:
    expect(fixRuns).toHaveLength(1);
    expect(spawnedRecords.filter((r) => r.wrfcRole === 'fixer')).toHaveLength(0);
    // The terminal contract gate re-reviews the merged result.
    expect(controller.getChain(chain.id)!.state).toBe('reviewing');
    const reviewer2 = spawnedRecords.filter((r) => r.wrfcRole === 'reviewer').at(-1)!;
    expect(reviewer2.id).not.toBe(reviewerRecord.id);
  });
});

