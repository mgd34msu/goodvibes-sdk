/**
 * approval-update-stream.test.ts
 *
 * The push channel for approval decisions, and the raise seam's preference for
 * it.
 *
 * The behaviour that matters is not "a frame arrives", it is what happens
 * around the frame: the gap between raising an ask and subscribing to it (a
 * decision taken in that window is never pushed, so it has to be read), and the
 * fallback when no stream can be opened at all (a permission ask blocks a tool
 * call, so it must still be answerable).
 */

import { expect, test } from 'bun:test';
import {
  APPROVAL_UPDATE_DOMAIN,
  approvalUpdateStreamUrl,
  readApprovalUpdateNotice,
} from '../packages/sdk/src/platform/runtime/client/approval-updates.ts';
import { createClientApprovalRaiser } from '../packages/sdk/src/platform/runtime/client/approval-raiser.ts';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from '../packages/sdk/src/platform/runtime/client/approval-updates.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';

const REQUEST: PermissionPromptRequest = {
  callId: 'call-1',
  tool: 'write',
  args: { path: '/w/file.ts' },
  category: 'write',
  analysis: {
    classification: 'file-write',
    riskLevel: 'medium',
    summary: 'write a file',
    reasons: ['it writes a file'],
  },
};

/** A verb caller that records what it was asked and answers from a script. */
function verbs(script: {
  readonly raisedId?: string | null;
  readonly listed?: () => unknown;
}) {
  const calls: { methodId: string; input: unknown }[] = [];
  return {
    calls,
    caller: {
      probe: () => ({ available: true as const }),
      invoke: async <T>(methodId: string, input?: unknown): Promise<T> => {
        calls.push({ methodId, input });
        if (methodId === 'approvals.raise') {
          return { approval: { id: script.raisedId ?? 'approval-1' } } as T;
        }
        if (methodId === 'approvals.list') return (script.listed?.() ?? []) as T;
        return {} as T;
      },
    },
  };
}

/** A prompt that never resolves, so only the remote path can decide. */
function neverPrompts() {
  return () => () => new Promise<never>(() => {});
}

test('the stream url narrows to the permissions domain', () => {
  const url = new URL(approvalUpdateStreamUrl('http://127.0.0.1:3421'));
  expect(url.pathname).toBe('/api/control-plane/events');
  // An unnarrowed subscriber receives every domain the daemon publishes and
  // discards nearly all of it.
  expect(url.searchParams.get('domains')).toBe(APPROVAL_UPDATE_DOMAIN);
});

test('a frame without a usable approval id is not acted on', () => {
  expect(readApprovalUpdateNotice(null)).toBeNull();
  expect(readApprovalUpdateNotice({})).toBeNull();
  expect(readApprovalUpdateNotice({ approval: {} })).toBeNull();
  expect(readApprovalUpdateNotice({ approval: { id: '' } })).toBeNull();
  const notice = readApprovalUpdateNotice({ approval: { id: 'a', status: 'approved' }, createdAt: 7 });
  expect(notice).toEqual({ approval: { id: 'a', status: 'approved' }, createdAt: 7 });
});

test('a decision pushed on the stream resolves the ask', async () => {
  const { caller, calls } = verbs({});
  let push: ((notice: ApprovalUpdateNotice) => void) | null = null;
  const raiser = createClientApprovalRaiser({
    verbs: caller,
    localPrompt: neverPrompts(),
    actor: 'test-surface',
    subscribeApprovalUpdates: async (onUpdate): Promise<ApprovalUpdateSubscription> => {
      push = onUpdate;
      return { close: (): void => {} };
    },
  });

  const decision = raiser({ request: REQUEST });
  // Let the raise + subscribe + gap-read settle before pushing.
  await new Promise((resolve) => setTimeout(resolve, 5));
  push!({ approval: { id: 'approval-1', status: 'approved', decision: { remember: true } }, createdAt: 1 });

  expect(await decision).toEqual({ approved: true, remember: true });
  // The record is the daemon's: the surface did not report a decision it did
  // not make.
  expect(calls.some((call) => call.methodId === 'approvals.approve')).toBe(false);
});

test('a decision taken in the gap before the subscription is still found', async () => {
  // The window this closes: the ask is answered between the raise returning and
  // the stream opening. No frame for it will ever arrive, because it happened
  // before there was anything to receive it.
  const { caller } = verbs({
    listed: () => [{ id: 'approval-1', status: 'denied' }],
  });
  const raiser = createClientApprovalRaiser({
    verbs: caller,
    localPrompt: neverPrompts(),
    actor: 'test-surface',
    subscribeApprovalUpdates: async (): Promise<ApprovalUpdateSubscription> => ({ close: (): void => {} }),
  });

  expect(await raiser({ request: REQUEST })).toEqual({ approved: false, remember: false });
});

test('a stream that cannot be opened falls back to reading the record', async () => {
  let reads = 0;
  const { caller } = verbs({
    listed: () => {
      reads += 1;
      return reads > 1 ? [{ id: 'approval-1', status: 'approved' }] : [];
    },
  });
  const raiser = createClientApprovalRaiser({
    verbs: caller,
    localPrompt: neverPrompts(),
    actor: 'test-surface',
    // Null means "no stream right now", a supported answer, not a failure.
    subscribeApprovalUpdates: async (): Promise<ApprovalUpdateSubscription | null> => null,
    pollIntervalMs: 1,
  });

  expect(await raiser({ request: REQUEST })).toEqual({ approved: true, remember: false });
  expect(reads).toBeGreaterThan(1);
});

test('a subscribe that throws falls back rather than failing the ask', async () => {
  const { caller } = verbs({
    listed: () => [{ id: 'approval-1', status: 'approved' }],
  });
  const raiser = createClientApprovalRaiser({
    verbs: caller,
    localPrompt: neverPrompts(),
    actor: 'test-surface',
    subscribeApprovalUpdates: async (): Promise<ApprovalUpdateSubscription> => {
      throw new Error('the proxy will not hold a connection');
    },
    pollIntervalMs: 1,
  });

  expect(await raiser({ request: REQUEST })).toEqual({ approved: true, remember: false });
});

test('a local answer still wins and is reported back to the daemon', async () => {
  const { caller, calls } = verbs({ listed: () => [] });
  const raiser = createClientApprovalRaiser({
    verbs: caller,
    localPrompt: () => async () => ({ approved: true, remember: false }),
    actor: 'test-surface',
    subscribeApprovalUpdates: async (): Promise<ApprovalUpdateSubscription> => ({ close: (): void => {} }),
  });

  expect(await raiser({ request: REQUEST })).toEqual({ approved: true, remember: false });
  // The daemon's record has to match what happened here, or every other surface
  // reads a pending ask that was already answered.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls.map((call) => call.methodId)).toContain('approvals.approve');
});

test('with no daemon reachable the ask is answered locally and nothing pretends otherwise', async () => {
  const calls: string[] = [];
  const raiser = createClientApprovalRaiser({
    verbs: {
      probe: () => ({ available: false as const, reason: 'no daemon is configured' }),
      invoke: async <T>(methodId: string): Promise<T> => { calls.push(methodId); return {} as T; },
    },
    localPrompt: () => async () => ({ approved: false, remember: false }),
    actor: 'test-surface',
    subscribeApprovalUpdates: async (): Promise<ApprovalUpdateSubscription> => ({ close: (): void => {} }),
  });

  expect(await raiser({ request: REQUEST })).toEqual({ approved: false, remember: false });
  expect(calls).toEqual([]);
});
