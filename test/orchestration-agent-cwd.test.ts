/**
 * Worktree isolation (wo/worktree-isolation) — stage (b): AgentOrchestrator
 * honors a per-call working-directory override.
 *
 * Verified BEFORE this stage: AgentOrchestrator.getFullRegistry() cached ONE
 * ToolRegistry with `workingDirectory` baked in at registration;
 * createRunContext() used a single fixed `toolDeps.workingDirectory`; there
 * was no per-call cwd seam anywhere in AgentInput/AgentRecord/
 * AgentOrchestratorRunContext.createRunContext(). This file proves the fix:
 *
 *   AgentInput.workingDirectory -> AgentRecord.workingDirectory (copied at
 *   spawn(), schema.ts/manager.ts) -> AgentOrchestrator.runAgent(record)
 *   -> createRunContext(record.workingDirectory) -> getFullRegistry(cwd),
 *   now keyed by cwd in a Map instead of a single cached field
 *   (orchestrator.ts).
 *
 * Two levels:
 *  1. Wiring — createRunContext(cwd) threads the override into BOTH
 *     `workingDirectory` and the `getFullRegistry` closure it hands back,
 *     without touching getFullRegistry's own real implementation.
 *  2. The real thing — getFullRegistry(cwd) against REAL tool deps: two
 *     distinct cwds produce two DISTINCT ToolRegistry instances, and a
 *     spawned agent's real `write` tool actually writes into whichever cwd
 *     its record carries — the concrete claim stage (b) exists to prove.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOrchestrator } from '../packages/sdk/src/platform/agents/orchestrator.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import type { AgentOrchestratorRunContext } from '../packages/sdk/src/platform/agents/orchestrator-runner.js';
import { AgentManager } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { FileStateCache } from '../packages/sdk/src/platform/state/file-cache.js';
import { ProjectIndex } from '../packages/sdk/src/platform/state/project-index.js';
import { FileUndoManager } from '../packages/sdk/src/platform/state/file-undo.js';
import { ModeManager } from '../packages/sdk/src/platform/state/mode-manager.js';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { createWorkflowServices } from '../packages/sdk/src/platform/tools/workflow/index.js';
import { CrossSessionTaskRegistry } from '../packages/sdk/src/platform/sessions/orchestration/registry.js';
import { SandboxSessionRegistry } from '../packages/sdk/src/platform/runtime/sandbox/session-registry.js';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.js';
import type { ToolRegistry } from '../packages/sdk/src/platform/tools/registry.js';

type PrivateOrchestrator = {
  toolDeps: Record<string, unknown>;
  getFullRegistry(workingDirectory?: string): ToolRegistry;
  createRunContext(workingDirectory?: string): AgentOrchestratorRunContext;
};

describe('AgentOrchestrator — createRunContext cwd threading (wiring)', () => {
  test('an override reaches BOTH workingDirectory and the bound getFullRegistry closure; omitted matches the default toolDeps cwd', () => {
    const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() }) as unknown as PrivateOrchestrator;
    orchestrator.toolDeps = { providerRegistry: {}, workingDirectory: '/default/cwd' };

    const registryByCwd = new Map<string, ToolRegistry>();
    orchestrator.getFullRegistry = ((cwd?: string) => {
      const key = cwd ?? '/default/cwd';
      if (!registryByCwd.has(key)) registryByCwd.set(key, { key } as unknown as ToolRegistry);
      return registryByCwd.get(key)!;
    }) as PrivateOrchestrator['getFullRegistry'];

    const defaultCtx = orchestrator.createRunContext();
    expect(defaultCtx.workingDirectory).toBe('/default/cwd');
    expect(defaultCtx.getFullRegistry()).toBe(registryByCwd.get('/default/cwd'));

    const overrideCtx = orchestrator.createRunContext('/item/worktree/path');
    expect(overrideCtx.workingDirectory).toBe('/item/worktree/path');
    expect(overrideCtx.getFullRegistry()).toBe(registryByCwd.get('/item/worktree/path'));
    expect(overrideCtx.getFullRegistry()).not.toBe(defaultCtx.getFullRegistry());

    // Calling with the SAME override twice returns the identical cached
    // registry instance — a second worktree-mode phase for the same item
    // must not pay a second registration cost.
    const overrideCtxAgain = orchestrator.createRunContext('/item/worktree/path');
    expect(overrideCtxAgain.getFullRegistry()).toBe(overrideCtx.getFullRegistry());
  });
});

/** Real (not stubbed) AgentOrchestratorToolDeps, minimal enough to satisfy registerAllTools's registration-time requirements without a full production wiring (runtime/services.ts). Scoped to `defaultDir` — matches `toolDeps.workingDirectory` exactly like real startup wiring. */
function makeRealToolDeps(defaultDir: string, scratchRoot: string): Record<string, unknown> {
  return {
    fileCache: new FileStateCache(),
    projectIndex: new ProjectIndex(defaultDir),
    workingDirectory: defaultDir,
    surfaceRoot: 'test-surface',
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    sessionOrchestration: new CrossSessionTaskRegistry(join(scratchRoot, 'session-tasks.json')),
    sandboxSessionRegistry: new SandboxSessionRegistry(scratchRoot),
    workflowServices: createWorkflowServices(),
    overflowHandler: new OverflowHandler({ baseDir: scratchRoot }),
    // registerAllTools resolves agentManager from either deps.agentManager or
    // deps.remoteRunnerRegistry.agentManager — a real AgentManager is cheap
    // and exercises the exact production duck-typed lookup path.
    agentManager: new AgentManager({
      configManager: { get: () => null },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* never spawned in this test */ } },
    }),
    configManager: {
      get: () => undefined,
      getCategory: () => undefined,
      getHomeDirectory: () => scratchRoot,
      getWorkingDirectory: () => defaultDir,
    },
    providerRegistry: {},
    toolLLM: {},
  };
}

describe('AgentOrchestrator — getFullRegistry(cwd) against REAL tool deps', () => {
  test('two distinct cwds get two DISTINCT registries; the default cwd is unaffected by a later override call', () => {
    const defaultDir = mkdtempSync(join(tmpdir(), 'agent-cwd-default-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'agent-cwd-other-'));
    const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-cwd-scratch-'));
    try {
      const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() }) as unknown as PrivateOrchestrator;
      orchestrator.toolDeps = makeRealToolDeps(defaultDir, scratchRoot);

      const defaultRegistry = orchestrator.getFullRegistry();
      const defaultRegistryAgain = orchestrator.getFullRegistry(defaultDir);
      const otherRegistry = orchestrator.getFullRegistry(otherDir);

      expect(defaultRegistry).toBe(defaultRegistryAgain); // same cwd → cached identity
      expect(defaultRegistry).not.toBe(otherRegistry); // distinct cwd → distinct registry
      expect(defaultRegistry.has('write')).toBe(true);
      expect(otherRegistry.has('write')).toBe(true);

      // Requesting the default again after building the override is unchanged.
      expect(orchestrator.getFullRegistry()).toBe(defaultRegistry);
    } finally {
      rmSync(defaultDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  test('the concrete claim: a real "write" tool call through the OVERRIDE registry lands inside the override directory, never the default one', async () => {
    const defaultDir = mkdtempSync(join(tmpdir(), 'agent-cwd-write-default-'));
    const worktreeDir = mkdtempSync(join(tmpdir(), 'agent-cwd-write-worktree-'));
    const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-cwd-write-scratch-'));
    try {
      const orchestrator = new AgentOrchestrator({ messageBus: new AgentMessageBus() }) as unknown as PrivateOrchestrator;
      orchestrator.toolDeps = makeRealToolDeps(defaultDir, scratchRoot);

      // Exactly what runAgent(record) does internally when
      // record.workingDirectory is set (orchestrator.ts): resolve a run
      // context bound to that cwd, then pull its tool registry.
      const worktreeContext = orchestrator.createRunContext(worktreeDir);
      const worktreeRegistry = worktreeContext.getFullRegistry();

      const result = await worktreeRegistry.execute('call-1', 'write', {
        files: [{ path: 'from-worktree.txt', content: 'written through the override cwd\n' }],
      });
      expect(result.success).toBe(true);

      expect(existsSync(join(worktreeDir, 'from-worktree.txt'))).toBe(true);
      expect(readFileSync(join(worktreeDir, 'from-worktree.txt'), 'utf-8')).toBe('written through the override cwd\n');
      // Never touched the default working directory.
      expect(existsSync(join(defaultDir, 'from-worktree.txt'))).toBe(false);

      // Default-cwd registry (no override) still resolves to defaultDir, unchanged.
      const defaultRegistry = orchestrator.getFullRegistry();
      const defaultResult = await defaultRegistry.execute('call-2', 'write', {
        files: [{ path: 'from-default.txt', content: 'written through the default cwd\n' }],
      });
      expect(defaultResult.success).toBe(true);
      expect(existsSync(join(defaultDir, 'from-default.txt'))).toBe(true);
      expect(existsSync(join(worktreeDir, 'from-default.txt'))).toBe(false);
    } finally {
      rmSync(defaultDir, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
