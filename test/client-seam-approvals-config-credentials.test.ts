/**
 * client-seam-approvals-config-credentials.test.ts — the three seams where a
 * surface stops being allowed to answer for itself.
 *
 * A chat host raising an ask into its own in-process broker makes that ask
 * invisible to every other surface, and a chat host writing
 * `surfaces.telegram.botToken` into its own settings file configures nothing
 * at all while reporting success. Both are silent failure modes, so the
 * policy is pinned once here, for every surface that adopts it.
 *
 * What each test is really about:
 *
 *  - APPROVALS: the race. An ask goes to the daemon AND prompts locally, and the
 *    first real answer wins. A decision taken elsewhere must resolve the ask
 *    here; a decision taken here must be written back so the daemon's record —
 *    the one every other surface reads — matches what happened.
 *  - CONFIG: reads may be optimistic, writes may not. A daemon-owned write with
 *    no daemon must REJECT rather than land in a file nothing reads.
 *  - CREDENTIALS: one verb, never two writes. A reference written without its
 *    value is worse than no write at all, and splitting the pair across a
 *    process boundary is exactly how that happens.
 */
import { describe, expect, test } from 'bun:test';
import { createClientApprovalRaiser } from '../packages/sdk/src/platform/runtime/client/approval-raiser.ts';
import { createDaemonConfigClient } from '../packages/sdk/src/platform/runtime/client/config-client.ts';
import { createDaemonCredentialsClient } from '../packages/sdk/src/platform/runtime/client/credentials-client.ts';
import type { DaemonVerbCaller } from '../packages/sdk/src/platform/runtime/client/daemon-verbs.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';

interface Recorder {
  readonly calls: Array<[string, unknown]>;
  readonly verbs: DaemonVerbCaller;
}

function recorder(
  handler: (methodId: string, input: unknown) => unknown,
  options: { unavailable?: string } = {},
): Recorder {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    verbs: {
      probe: () => (options.unavailable
        ? { available: false as const, reason: options.unavailable }
        : { available: true as const }),
      invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
        calls.push([methodId, input ?? {}]);
        return handler(methodId, input) as T;
      },
    },
  };
}

function ask(): PermissionPromptRequest {
  return {
    callId: 'call-1',
    tool: 'bash',
    args: { command: 'ls -la' },
    category: 'execute',
    analysis: { riskLevel: 'low', reasons: ['a check'], classification: 'read', summary: 'list files' },
  } as unknown as PermissionPromptRequest;
}

const never = <T,>(): Promise<T> => new Promise<T>(() => { /* the prompt nobody answers */ });

describe('a permission ask leaves this surface and the first real answer wins', () => {
  test('the local answer wins, and the daemon is told what was decided', async () => {
    const rec = recorder((methodId) => (methodId === 'approvals.raise'
      ? { approval: { id: 'ap-1', status: 'pending' } }
      : {}));
    const raise = createClientApprovalRaiser({
      verbs: rec.verbs,
      actor: 'testsurface',
      localPrompt: () => async () => ({ approved: true, remember: true }),
      pollIntervalMs: 1,
      sleep: async () => { /* the poll never has to wait */ },
    });

    const decision = await raise({ request: ask() });
    expect(decision.approved).toBe(true);
    // The write-back is fired without being awaited (the user has already been
    // served), so let the microtask that carries it run.
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    const ids = rec.calls.map(([methodId]) => methodId);
    expect(ids[0]).toBe('approvals.raise');
    expect(ids).toContain('approvals.approve');
    const wrote = rec.calls.find(([methodId]) => methodId === 'approvals.approve')?.[1] as Record<string, unknown>;
    // The actor is the surface's own name, not a hard-coded one: the daemon's
    // record is what every other surface reads to see WHERE this was answered.
    expect(wrote['actor']).toBe('testsurface');
    expect(wrote['actorSurface']).toBe('testsurface');
    expect(wrote['remember']).toBe(true);
  });

  test('a decision taken on another surface resolves the ask here', async () => {
    let listed = 0;
    const rec = recorder((methodId) => {
      if (methodId === 'approvals.raise') return { approval: { id: 'ap-2', status: 'pending' } };
      if (methodId === 'approvals.list') {
        listed += 1;
        // Answered elsewhere on the second read — a phone, the web app, another
        // terminal. The local prompt is still open and is simply overtaken.
        return listed >= 2 ? { approvals: [{ id: 'ap-2', status: 'denied', decision: { remember: false } }] } : { approvals: [] };
      }
      return {};
    });
    const raise = createClientApprovalRaiser({
      verbs: rec.verbs,
      actor: 'testsurface',
      localPrompt: () => () => never<{ approved: boolean; remember: boolean }>(),
      pollIntervalMs: 1,
      sleep: async () => { /* drive the poll without a clock */ },
    });

    const decision = await raise({ request: ask() });
    expect(decision.approved).toBe(false);
    // Nothing is written back for a decision this surface did not take: the
    // daemon already holds it.
    expect(rec.calls.map(([methodId]) => methodId)).not.toContain('approvals.deny');
  });

  test('with no daemon reachable the ask is prompted and answered locally, not swallowed', async () => {
    const rec = recorder(() => ({}), { unavailable: 'the daemon is disabled (daemon.enabled=false)' });
    const raise = createClientApprovalRaiser({
      verbs: rec.verbs,
      actor: 'testsurface',
      localPrompt: () => async () => ({ approved: true, remember: false }),
    });
    const decision = await raise({ request: ask() });
    // A user in front of a surface can still approve their own tool call with
    // no daemon running. What must not happen is a pretend remote record.
    expect(decision.approved).toBe(true);
    expect(rec.calls).toEqual([]);
  });

  test('a raise that fails on the wire still prompts locally rather than failing the turn', async () => {
    const rec = recorder((methodId) => {
      if (methodId === 'approvals.raise') throw new Error('connection reset');
      return {};
    });
    const raise = createClientApprovalRaiser({
      verbs: rec.verbs,
      actor: 'testsurface',
      localPrompt: () => async () => ({ approved: false, remember: false }),
    });
    expect((await raise({ request: ask() })).approved).toBe(false);
  });
});

describe('a daemon-owned config key is written where the daemon reads it', () => {
  test('a write goes over config.set and a read walks the resolved tree', async () => {
    const rec = recorder((methodId) => (methodId === 'config.get'
      ? { watchers: { enabled: false } }
      : {}));
    const config = createDaemonConfigClient(rec.verbs);
    expect(config.ownsKey('watchers.enabled')).toBe(true);
    await config.set('watchers.enabled', false);
    expect(rec.calls[0]).toEqual(['config.set', { key: 'watchers.enabled', value: false }]);
    // `config.get` takes no key — it answers with the whole tree — so the dotted
    // walk happens here rather than in every caller that wanted one value.
    expect(await config.get('watchers.enabled')).toBe(false);
    expect(rec.calls[1]).toEqual(['config.get', {}]);
  });

  test('a daemon-owned write with no daemon REJECTS instead of writing locally', async () => {
    const rec = recorder(() => ({}), { unavailable: 'no control-plane base URL is configured' });
    const config = createDaemonConfigClient(rec.verbs);
    // A silent local write is the exact failure this split exists to end: it
    // looks like it worked and changes nothing.
    await expect(config.set('surfaces.telegram.botToken', 'x')).rejects.toThrow('no control-plane base URL');
    expect(rec.calls).toEqual([]);
  });

  test('a read the daemon cannot answer is undefined, not a thrown turn', async () => {
    const rec = recorder(() => { throw new Error('connection reset'); });
    expect(await createDaemonConfigClient(rec.verbs).get('watchers.enabled')).toBeUndefined();
    expect(await createDaemonConfigClient(rec.verbs).snapshot()).toBeNull();
  });

  test('a key with no value in the tree reads undefined rather than a partial object', async () => {
    const rec = recorder(() => ({ watchers: {} }));
    expect(await createDaemonConfigClient(rec.verbs).get('watchers.enabled.deep')).toBeUndefined();
  });
});

describe('a credential and the config reference that points at it stay together', () => {
  test('one verb carries the whole sequence, keyed by the CONFIG key', async () => {
    const rec = recorder(() => ({ key: 'surfaces.telegram.botToken', reference: 'goodvibes://secrets/x', scope: 'global' }));
    const credentials = createDaemonCredentialsClient(rec.verbs);
    const receipt = await credentials.set('surfaces.telegram.botToken', 'not-a-real-token');
    expect(rec.calls[0]).toEqual(['credentials.set', { key: 'surfaces.telegram.botToken', value: 'not-a-real-token' }]);
    // What comes back names the key, the scope and the reference — never the
    // value, on success or otherwise.
    expect(JSON.stringify(receipt)).not.toContain('not-a-real-token');
  });

  test('clearing removes both halves through the same one verb', async () => {
    const rec = recorder(() => ({}));
    await createDaemonCredentialsClient(rec.verbs).clear('surfaces.telegram.botToken');
    expect(rec.calls[0]).toEqual(['credentials.delete', { key: 'surfaces.telegram.botToken' }]);
  });

  test('with no daemon reachable the write REJECTS rather than splitting the pair', async () => {
    const rec = recorder(() => ({}), { unavailable: 'the daemon is disabled (daemon.enabled=false)' });
    const credentials = createDaemonCredentialsClient(rec.verbs);
    await expect(credentials.set('surfaces.telegram.botToken', 'x')).rejects.toThrow('daemon.enabled=false');
    // Nothing was attempted: a local write here produces a config key pointing
    // at a reference the daemon resolves to nothing.
    expect(rec.calls).toEqual([]);
  });
});
