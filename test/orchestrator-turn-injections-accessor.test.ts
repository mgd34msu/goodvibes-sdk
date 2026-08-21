/**
 * Orchestrator.getTurnInjections() accessor wiring.
 *
 * The MAIN interactive session has no AgentRecord (that's the agent path's per-agent
 * `AgentRecord.turnInjections` ring), so the orchestrator exposes a session-lifetime equivalent
 * directly on the Orchestrator class: `getTurnInjections(): readonly TurnInjectionRecord[]`.
 * This is the exact accessor a `/recall`-style renderer should read as the main-session
 * default when no agent id is given (see core/orchestrator-turn-loop.ts's
 * recordTurnKnowledgeInjection wiring for how entries land here during a real turn).
 *
 * Constructing a full `Orchestrator` needs 6+ required constructor params plus
 * post-construction `setCoreServices()` wiring (see orchestrator-abort.test.ts's own
 * comment on this), so, matching that file's established pattern, this test uses
 * `Object.create(Orchestrator.prototype)` to exercise the real class's private
 * ring-management methods and public accessor directly, without needing a live turn loop.
 */
import { describe, expect, test } from 'bun:test';
import { Orchestrator } from '../packages/sdk/src/platform/core/orchestrator.js';
import type { TurnInjectionRecord } from '../packages/sdk/src/platform/agents/turn-knowledge-injection.js';

type OrchestratorPrivateSurface = {
  turnKnowledgeIdsAlreadySurfaced: Set<string>;
  turnInjectionRing: TurnInjectionRecord[];
  turnKnowledgeSequence: number;
  flagManager: { isEnabled: (id: string) => boolean } | null;
  getAlreadyInjectedKnowledgeIds(): readonly string[];
  addInjectedKnowledgeIds(ids: readonly string[]): void;
  recordTurnKnowledgeInjection(record: TurnInjectionRecord): void;
  nextTurnKnowledgeSequence(): number;
  isPassiveKnowledgeInjectionEnabled(): boolean;
};

/**
 * Orchestrator has private fields with the same names used below
 * (turnKnowledgeIdsAlreadySurfaced, flagManager, ...). Intersecting
 * `InstanceType<typeof Orchestrator>` with a plain object type declaring
 * those same names collides with the class's private nominal typing and
 * collapses the whole type to `never` (see orchestrator-abort.test.ts for
 * the established precedent: cast to `unknown` first, per access, rather
 * than trying to build one merged type).
 */
function makeBareOrchestrator(): InstanceType<typeof Orchestrator> {
  const orch = Object.create(Orchestrator.prototype) as InstanceType<typeof Orchestrator>;
  const priv = orch as unknown as OrchestratorPrivateSurface;
  priv.turnKnowledgeIdsAlreadySurfaced = new Set<string>();
  priv.turnInjectionRing = [];
  priv.turnKnowledgeSequence = 0;
  priv.flagManager = null;
  return orch;
}

function bareOrchestratorPrivateSurface(orch: InstanceType<typeof Orchestrator>): OrchestratorPrivateSurface {
  return orch as unknown as OrchestratorPrivateSurface;
}

function makeRecord(overrides: Partial<TurnInjectionRecord> & { turn: number }): TurnInjectionRecord {
  return {
    query: 'test query',
    candidatesConsidered: 1,
    codeCandidatesConsidered: 0,
    injectedIds: [],
    injectedSources: [],
    droppedForBudget: [],
    tokenCost: 0,
    budgetTokens: 800,
    relevanceFloor: 95,
    ingestModes: [],
    embeddingBackend: 'fallback-lexical',
    ...overrides,
  };
}

describe('Orchestrator.getTurnInjections() — main-session accessor', () => {
  test('starts empty', () => {
    const orch = makeBareOrchestrator();
    expect(orch.getTurnInjections()).toEqual([]);
  });

  test('recordTurnKnowledgeInjection appends to the ring returned by getTurnInjections()', () => {
    const orch = makeBareOrchestrator();
    const record = makeRecord({ turn: 1, injectedIds: ['mem_a'] });
    bareOrchestratorPrivateSurface(orch).recordTurnKnowledgeInjection(record);

    expect(orch.getTurnInjections()).toEqual([record]);
  });

  test('the ring is bounded (mirrors AgentRecord.turnInjections eviction via the shared recordTurnInjection util)', () => {
    const orch = makeBareOrchestrator();
    const priv = bareOrchestratorPrivateSurface(orch);
    for (let i = 1; i <= 25; i++) {
      priv.recordTurnKnowledgeInjection(makeRecord({ turn: i }));
    }
    const ring = orch.getTurnInjections();
    expect(ring.length).toBeLessThan(25);
    expect(ring[ring.length - 1]!.turn).toBe(25);
  });

  test('getAlreadyInjectedKnowledgeIds/addInjectedKnowledgeIds: starts empty (no spawn-time baseline) and grows monotonically', () => {
    const orch = makeBareOrchestrator();
    const priv = bareOrchestratorPrivateSurface(orch);
    expect(priv.getAlreadyInjectedKnowledgeIds()).toEqual([]);

    priv.addInjectedKnowledgeIds(['mem_a', 'mem_b']);
    expect([...priv.getAlreadyInjectedKnowledgeIds()].sort()).toEqual(['mem_a', 'mem_b']);

    priv.addInjectedKnowledgeIds(['mem_c']);
    expect([...priv.getAlreadyInjectedKnowledgeIds()].sort()).toEqual(['mem_a', 'mem_b', 'mem_c']);

    // Adding an id already present is idempotent (backed by a Set).
    priv.addInjectedKnowledgeIds(['mem_a']);
    expect([...priv.getAlreadyInjectedKnowledgeIds()].sort()).toEqual(['mem_a', 'mem_b', 'mem_c']);
  });

  test('nextTurnKnowledgeSequence() is monotonic across calls (session-lifetime, not per-call)', () => {
    const orch = makeBareOrchestrator();
    const priv = bareOrchestratorPrivateSurface(orch);
    expect(priv.nextTurnKnowledgeSequence()).toBe(1);
    expect(priv.nextTurnKnowledgeSequence()).toBe(2);
    expect(priv.nextTurnKnowledgeSequence()).toBe(3);
  });

  test('isPassiveKnowledgeInjectionEnabled(): defaults to true with no flag manager, defers to the SAME agent-passive-knowledge-injection flag id when one is wired', () => {
    const orch = makeBareOrchestrator();
    const priv = bareOrchestratorPrivateSurface(orch);
    expect(priv.isPassiveKnowledgeInjectionEnabled()).toBe(true);

    const calls: string[] = [];
    priv.flagManager = { isEnabled: (id: string) => { calls.push(id); return false; } };
    expect(priv.isPassiveKnowledgeInjectionEnabled()).toBe(false);
    expect(calls).toEqual(['agent-passive-knowledge-injection']);
  });
});
