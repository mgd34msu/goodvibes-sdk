/**
 * agent-orchestrator-project-index-ownership.test.ts
 *
 * An agent spawned into its own working directory (a dedicated worktree) is
 * given a ToolRegistry bound to that cwd, and `registerAllTools` builds it a
 * fresh `ProjectIndex` because the shared one belongs to the default cwd and
 * would index the wrong tree. That index holds a debounced 5s flush timer.
 *
 * `registerAllTools` hands the index back to its caller, and the orchestrator
 * threw the return value away — so the only remaining references lived inside
 * the tool closures of a cached registry. Nothing could flush it, nothing could
 * cancel its timer, and dropping the registry (a channel plugin changing the
 * registry version, or the graph being disposed) simply orphaned it.
 *
 * Measured against the real graph rather than a stand-in, because the defect
 * was in who holds the object, and a stand-in is exactly where that gets lost.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../packages/sdk/src/platform/runtime/services.ts';
import type { ProjectIndex } from '../packages/sdk/src/platform/state/project-index.ts';

/**
 * `getFullRegistry(cwd)` is private — it is reached from `execute()` with a
 * record's workingDirectory, and standing up a full agent run to observe an
 * object-ownership property would measure ten other things at once. Other tests
 * in this suite reach internals the same way (see auth-events.test.ts).
 */
interface OrchestratorInternals {
  getFullRegistry(workingDirectory?: string): unknown;
  ownedProjectIndexes: Map<string, ProjectIndex>;
  toolDeps: { projectIndex: ProjectIndex } | null;
}

interface IndexInternals { flushTimer: unknown }

let root: string;
let agentCwd: string;
let services: RuntimeServices;
let ownedIndex: ProjectIndex | undefined;
let ownedCountBeforeDispose = 0;
let ownedCountAfterDispose = 0;
let flushTimerBeforeDispose: unknown;
let flushTimerAfterDispose: unknown;
let sharedIndexTimerAfterDispose: unknown;
/** Kept so afterAll can put down the flush this file armed on purpose. */
let sharedIndexRef: ProjectIndex | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orchestrator-index-'));
  agentCwd = mkdtempSync(join(tmpdir(), 'orchestrator-agent-cwd-'));

  services = createRuntimeServices({
    configManager: new ConfigManager({ surfaceRoot: 'daemon', configDir: join(root, 'cfg'), workingDir: root, homeDir: root }),
    runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(),
    surfaceRoot: 'goodvibes',
    workingDir: root,
    homeDirectory: root,
  });

  const orchestrator = services.agentOrchestrator as unknown as OrchestratorInternals;
  // The registry an agent spawned into its own worktree gets.
  orchestrator.getFullRegistry(agentCwd);
  ownedIndex = orchestrator.ownedProjectIndexes.get(agentCwd);
  ownedCountBeforeDispose = orchestrator.ownedProjectIndexes.size;

  // Arm the debounced flush the way tool use does, so there is a live timer to
  // account for rather than an assertion about an idle object.
  ownedIndex?.upsertFile('src/example.ts', 120);
  flushTimerBeforeDispose = (ownedIndex as unknown as IndexInternals | undefined)?.flushTimer;

  // The SHARED index — the one the composition root owns and the orchestrator
  // only borrows — gets a pending flush too, so the next assertion can show
  // dispose() left it alone instead of reaching past its own property.
  const sharedIndex = orchestrator.toolDeps!.projectIndex;
  sharedIndexRef = sharedIndex;
  sharedIndex.upsertFile('src/shared.ts', 90);

  services.dispose();
  ownedCountAfterDispose = orchestrator.ownedProjectIndexes.size;
  flushTimerAfterDispose = (ownedIndex as unknown as IndexInternals | undefined)?.flushTimer;
  sharedIndexTimerAfterDispose = (sharedIndex as unknown as IndexInternals).flushTimer;
});

afterAll(async () => {
  // The shared index's pending flush is armed deliberately above, to show
  // dispose() does NOT touch a borrowed object. Once that has been read, this
  // file owns it: leaving it armed would be the very class of stray handle
  // these tests exist to close, inside every later file of the shared-process
  // leak scan.
  await sharedIndexRef?.dispose();
  rmSync(root, { recursive: true, force: true });
  rmSync(agentCwd, { recursive: true, force: true });
});

test('a registry for a non-default cwd yields an index the orchestrator actually keeps', () => {
  expect(ownedIndex).toBeDefined();
  expect(ownedCountBeforeDispose).toBe(1);
  // Not vacuous: there really is a pending flush to cancel.
  expect(flushTimerBeforeDispose).not.toBeNull();
  expect(flushTimerBeforeDispose).toBeDefined();
});

test('dispose() releases every index the orchestrator built', () => {
  expect(flushTimerAfterDispose).toBeNull();
  expect(ownedCountAfterDispose).toBe(0);
});

test('the shared index the composition root owns is left alone', () => {
  // Disposing a borrowed object is how a live session loses its index; the
  // default cwd's index is never in the owned map, so its pending flush stands.
  expect(sharedIndexTimerAfterDispose).not.toBeNull();
});
