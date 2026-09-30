/**
 * One notification-history entry per agent or chain event. Live run 9 showed
 * /notifications listing each chain and agent event twice: once under its
 * plain title (the host's runtime-bus bridge) and once as the "[WRFC] …" /
 * "[Agents] …" line registerHostRuntimeEvents writes for the same event.
 * runtimeEventOfNotice names the event behind each such line, so a host keeps
 * one entry under the plain title. This drives every producer through the
 * real registration so the matcher and the lines cannot drift apart.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import { registerHostRuntimeEvents, runtimeEventKey, runtimeEventOfNotice, type HostRuntimeMessageRouter } from '../packages/sdk/src/platform/runtime/bootstrap-runtime-events.js';

function harness() {
  const lines: string[] = [];
  const router: HostRuntimeMessageRouter = { low: (m) => lines.push(m), high: (m) => lines.push(m), wrfc: (m) => lines.push(m) };
  const bus = new RuntimeEventBus();
  const record = { id: 'agent-b6834750', template: 'engineer', task: 'Cap the "retry" delay\nand add a test', status: 'completed', startedAt: 0, completedAt: 51_000, toolCallCount: 3 };
  registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: new Proxy({}, { get: () => () => {} }) as never,
    getSystemMessageRouter: () => router,
    requestRender: () => {},
    configManager: { get: () => 9 } as never,
    agentManager: { getStatus: () => record, listByCohort: () => [], list: () => [] } as never,
    wrfcController: { getChain: () => null, listChains: () => [] } as never,
  });
  return { bus, lines };
}

const ctx = { sessionId: 't', traceId: 't', source: 't' };

describe('runtimeEventOfNotice', () => {
  const cases: Array<[domain: 'agents' | 'workflows', type: string, payload: Record<string, unknown>, title: string]> = [
    ['agents', 'AGENT_COMPLETED', { agentId: 'agent-b6834750', durationMs: 51_000 }, 'Agent finished'],
    ['agents', 'AGENT_FAILED', { agentId: 'agent-b6834750', error: 'the provider refused: quota', durationMs: 51_000 }, 'Agent failed'],
    ['workflows', 'WORKFLOW_CHAIN_PASSED', { chainId: 'wrfc-e9823b88aa' }, 'Review chain passed'],
    ['workflows', 'WORKFLOW_CHAIN_FAILED', { chainId: 'wrfc-e9823b88aa', reason: 'gates failed twice' }, 'Review chain failed'],
    ['workflows', 'WORKFLOW_CASCADE_ABORTED', { chainId: 'wrfc-e9823b88aa', reason: 'parent failed' }, 'Review chain stopped'],
    ['workflows', 'WORKFLOW_AUTO_COMMITTED', { chainId: 'wrfc-e9823b88aa', commitHash: '0123456789abcdef' }, 'Reviewed changes committed'],
    ['workflows', 'WORKFLOW_SCORE_REGRESSION', { chainId: 'wrfc-e9823b88aa', reason: 'score fell from 9 to 6' }, 'Review score dropped'],
  ];
  for (const [domain, type, payload, title] of cases) {
    test(`the line written for ${type} is recognized as that event, titled "${title}"`, async () => {
      const { bus, lines } = harness();
      bus.emit(domain, createEventEnvelope(type as never, { type, ...payload } as never, ctx));
      await Promise.resolve();
      expect(lines).toHaveLength(1);
      const notice = runtimeEventOfNotice(lines[0]!);
      expect(notice?.type).toBe(type);
      expect(notice?.title).toBe(title);
      expect(notice?.detail.startsWith('[')).toBe(false);
      expect(notice?.detail.length).toBeGreaterThan(0);
      // The line and the bus event name the same event.
      expect(notice?.key).toBe(runtimeEventKey(type, { type, ...payload })!);
      expect(runtimeEventKey(type, { type, ...payload, agentId: 'agent-00000000', chainId: 'wrfc-other000000' })).not.toBe(notice?.key);
    });
  }

  const keyless: Array<[type: string, payload: Record<string, unknown>, title: string]> = [
    ['WORKFLOW_CHAIN_CREATED', { chainId: 'wrfc-1234567890ab', task: 'Cap the retry delay' }, 'Review chain started'],
    ['WORKFLOW_REVIEW_COMPLETED', { chainId: 'wrfc-1234567890ab', score: 10, passed: true }, 'Review passed'],
    ['WORKFLOW_REVIEW_COMPLETED', { chainId: 'wrfc-1234567890ab', score: 6, passed: false }, 'Review asked for fixes'],
    ['WORKFLOW_GATE_RESULT', { chainId: 'wrfc-1234567890ab', gate: 'typecheck', passed: true }, 'Quality check passed'],
    ['WORKFLOW_GATE_RESULT', { chainId: 'wrfc-1234567890ab', gate: 'lint', passed: false }, 'Quality check failed'],
  ];
  for (const [type, payload, title] of keyless) {
    test(`the line written for ${type} reads "${title}" and carries no key (nothing else records it)`, async () => {
      const { bus, lines } = harness();
      bus.emit('workflows', createEventEnvelope(type as never, { type, ...payload } as never, ctx));
      await Promise.resolve();
      expect(lines).toHaveLength(1);
      const notice = runtimeEventOfNotice(lines[0]!);
      expect(notice?.title).toBe(title);
      expect(notice?.key).toBeUndefined();
      expect(notice?.detail.startsWith('[')).toBe(false);
    });
  }

  test('lines that restate no chain or agent event are not matched', () => {
    expect(runtimeEventOfNotice('[WRFC] ✗ Chain wrfc-1: 2 constraint violations forced failure')).toBeUndefined();
    expect(runtimeEventOfNotice('Compaction finished')).toBeUndefined();
    expect(runtimeEventOfNotice('[Failover] Restored abacusai:route-llm for the next turn.')).toBeUndefined();
    expect(runtimeEventKey('WORKFLOW_CHAIN_CREATED', { chainId: 'wrfc-1' })).toBeUndefined();
  });

  test('a passed chain\'s line carries what happened to its work, e.g. a commit hook\'s refusal, as the entry body', async () => {
    const { bus, lines } = harness();
    const note = "your repository's commit hooks refused the chain's commit, so nothing was committed and your files were not changed; the chain's work is kept on branch wrfc/101714ad. git commit said: lint: magic number";
    bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_PASSED' as never, { type: 'WORKFLOW_CHAIN_PASSED', chainId: 'wrfc-101714ad00', note } as never, ctx));
    await Promise.resolve();
    expect(lines[0]).toBe(`[WRFC] \u2713 Chain wrfc-101714a PASSED \u2014 all gates clear\n${note}`);
    const notice = runtimeEventOfNotice(lines[0]!);
    expect(notice?.title).toBe('Review chain passed');
    expect(notice?.detail).toContain('git commit said: lint: magic number');
  });
});
