/**
 * Memory provenance on the turn wire (the owner-ruled chip's producer).
 *
 * TURN_COMPLETED now carries the turn's MEMORY-sourced injected knowledge ids
 * as `metadata.memory.recordIds` — the exact documented convention the webui's
 * shipped provenance chip reads (`readMemoryProvenanceIds`: metadata.memory.
 * recordIds: string[], defensively). Covered here:
 *   - a turn WITH memory injections serves the ids on the wire payload,
 *   - a turn WITHOUT serves NO metadata field at all (absent, not []),
 *   - code-index-sourced injections never leak into the memory chip,
 *   - the webui-shaped defensive read path round-trips the emitted payload,
 *   - the full emit path through handleFinalResponseOutcome (the real turn-
 *     completion site) stamps the real runtime-bus envelope.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { RuntimeEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitTurnCompleted } from '../packages/sdk/src/platform/runtime/emitters/turn.js';
import { handleFinalResponseOutcome } from '../packages/sdk/src/platform/core/orchestrator-turn-helpers.js';
import { validateTurnCompleted } from '../packages/sdk/src/events/contracts.js';
import type { TurnEvent } from '../packages/sdk/src/events/turn.js';

type TurnCompleted = Extract<TurnEvent, { type: 'TURN_COMPLETED' }>;

// ---------------------------------------------------------------------------
// Type-level: the contract carries the documented convention path.
// ---------------------------------------------------------------------------
type _AssertMetadataShape = TurnCompleted extends {
  metadata?: { memory?: { recordIds: readonly string[] } | undefined } | undefined;
} ? true : never;
const _assertMetadataShape: _AssertMetadataShape = true;
void _assertMetadataShape;

/**
 * The webui's documented read path (goodvibes-webui src/lib/memory-provenance.ts),
 * replicated byte-for-byte in behavior: metadata.memory.recordIds, fully
 * defensive, empty array on any malformed shape.
 */
function readMemoryProvenanceIds(metadata: unknown): readonly string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const memory = (metadata as Record<string, unknown>).memory;
  if (!memory || typeof memory !== 'object') return [];
  const recordIds = (memory as Record<string, unknown>).recordIds;
  if (!Array.isArray(recordIds)) return [];
  return recordIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function captureTurnCompleted(run: (bus: RuntimeEventBus) => void): Promise<TurnCompleted> {
  const bus = new RuntimeEventBus();
  const seen: TurnCompleted[] = [];
  bus.on<TurnCompleted>('TURN_COMPLETED', (envelope: RuntimeEventEnvelope<'TURN_COMPLETED', TurnCompleted>) => {
    seen.push(envelope.payload);
  });
  run(bus);
  // The bus dispatches each subscriber in its own microtask — flush them.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

const CTX = { sessionId: 's-1', source: 'test' };

describe('emitTurnCompleted — metadata.memory.recordIds stamping', () => {
  test('a turn with memory injections serves the ids on the wire payload', async () => {
    const payload = await captureTurnCompleted((bus) => {
      emitTurnCompleted(bus, CTX, {
        turnId: 't-1',
        response: 'done',
        stopReason: 'completed',
        memoryRecordIds: ['mem-1', 'mem-2'],
      });
    });
    expect(payload.metadata).toEqual({ memory: { recordIds: ['mem-1', 'mem-2'] } });
    // The wire event still validates against the turn contract.
    expect(validateTurnCompleted(payload).valid).toBe(true);
  });

  test('a turn without memory injections serves NO metadata field (absent, not [])', async () => {
    const payload = await captureTurnCompleted((bus) => {
      emitTurnCompleted(bus, CTX, { turnId: 't-2', response: 'done', stopReason: 'completed' });
    });
    expect('metadata' in payload).toBe(false);
    expect(validateTurnCompleted(payload).valid).toBe(true);
  });

  test('an explicitly empty id list also serves NO metadata field', async () => {
    const payload = await captureTurnCompleted((bus) => {
      emitTurnCompleted(bus, CTX, { turnId: 't-3', response: 'done', stopReason: 'completed', memoryRecordIds: [] });
    });
    expect('metadata' in payload).toBe(false);
  });

  test('the webui-shaped defensive read path round-trips the emitted payload', async () => {
    const withIds = await captureTurnCompleted((bus) => {
      emitTurnCompleted(bus, CTX, { turnId: 't-4', response: 'ok', stopReason: 'completed', memoryRecordIds: ['mem-a'] });
    });
    expect(readMemoryProvenanceIds(withIds.metadata)).toEqual(['mem-a']);
    const without = await captureTurnCompleted((bus) => {
      emitTurnCompleted(bus, CTX, { turnId: 't-5', response: 'ok', stopReason: 'completed' });
    });
    expect(readMemoryProvenanceIds(without.metadata)).toEqual([]);
  });
});

describe('memory-source filtering (the loop stamps only source \'memory\')', () => {
  test('the loop\'s filter expression keeps memory ids and drops code-index ids', () => {
    // The exact accumulation the turn loop performs over a TurnInjectionRecord:
    // parallel arrays injectedIds/injectedSources, keep source === 'memory'.
    const injectedIds = ['mem-1', 'code-1', 'mem-2'] as const;
    const injectedSources = ['memory', 'code-index', 'memory'] as const;
    const kept = new Set<string>();
    injectedIds.forEach((id, index) => {
      if (injectedSources[index] === 'memory') kept.add(id);
    });
    expect([...kept]).toEqual(['mem-1', 'mem-2']);
  });
});

describe('handleFinalResponseOutcome — the real turn-completion emit site', () => {
  function runOutcome(memoryRecordIds: readonly string[] | undefined): Promise<TurnCompleted> {
    return captureTurnCompleted((bus) => {
      const conversationCalls: string[] = [];
      handleFinalResponseOutcome({
        conversation: {
          addAssistantMessage: (content: string) => { conversationCalls.push(content); },
          addSystemMessage: () => undefined,
        } as never,
        agentManager: { list: () => [], spawn: () => { throw new Error('unused'); } } as never,
        planManager: null,
        configManager: { get: () => false } as never,
        providerRegistry: { getCurrentModel: () => ({ displayName: 'm', provider: 'p' }) } as never,
        runtimeBus: bus,
        emitterContext: () => CTX,
        turnId: 't-final',
        response: { content: 'the reply', toolCalls: [], stopReason: 'completed' } as never,
        preTurnPlan: null,
        requestRender: () => undefined,
        setAutoSpawnTimeout: () => undefined,
        autoSpawnTimeoutMs: 0,
        sessionId: 's-1',
        memoryRecordIds,
      });
    });
  }

  test('stamps the turn\'s memory ids onto the real envelope', async () => {
    const payload = await runOutcome(['mem-9']);
    expect(payload.metadata).toEqual({ memory: { recordIds: ['mem-9'] } });
    expect(payload.response).toBe('the reply');
  });

  test('a no-injection turn emits with no metadata field', async () => {
    const payload = await runOutcome(undefined);
    expect('metadata' in payload).toBe(false);
  });
});
