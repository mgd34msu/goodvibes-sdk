/**
 * approvals-raise-verb.test.ts
 *
 * A surface raising an ask INTO the daemon's shared broker, and the push that
 * makes the answer arrive without polling.
 *
 * Three properties are what this family is for, so three are asserted:
 *   - raise creates a real, listable, decidable record and RETURNS rather than
 *     blocking on a human;
 *   - the record's every transition reaches an SSE/WS subscriber on the
 *     `permissions` domain, including the first one, which IS the prompt;
 *   - the existing in-process path (`requestApproval`) still resolves exactly
 *     as it did, including duplicate-ask coalescing, because it now runs
 *     through the same free function raise does.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.ts';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createApprovalRaiseHandler } from '../packages/sdk/src/platform/control-plane/routes/approvals-raise.ts';
import { isGatewayVerbError } from '../packages/sdk/src/platform/control-plane/routes/gateway-verb-error.ts';
import { builtinGatewayControlCoreMethodDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-control-core.ts';
import { builtinGatewayEventDescriptors } from '../packages/sdk/src/platform/control-plane/method-catalog-events.ts';
import { EVENT_DOMAIN } from '../packages/sdk/src/platform/control-plane/gateway-scope-enforcement.ts';
import type { RuntimeEventDomain } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { GatewayMethodInvocation } from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';

function makeBroker(): { broker: ApprovalBroker; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approvals-raise-'));
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  return { broker, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ask(callId: string, tool = 'exec'): Record<string, unknown> {
  return {
    callId,
    tool,
    args: { command: 'ls -la' },
    category: 'execute',
    analysis: {
      classification: 'shell-command',
      riskLevel: 'medium',
      summary: 'Run `ls -la` in the project root',
      reasons: ['It reads the working tree.'],
    },
  };
}

function invocation(params: Record<string, unknown>): GatewayMethodInvocation {
  return {
    body: params,
    context: { principalId: 'operator', principalKind: 'user', clientKind: 'web' },
  };
}

describe('approvals.raise — creating an ask from a surface', () => {
  test('returns the pending record immediately and does not wait for a decision', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const handler = createApprovalRaiseHandler(broker);
      const started = Date.now();
      const result = await handler(invocation({ request: ask('call-1') })) as {
        approval: { id: string; status: string; callId: string; metadata: Record<string, unknown> };
        coalesced: boolean;
        decided: boolean;
      };

      expect(result.approval.status).toBe('pending');
      expect(result.approval.callId).toBe('call-1');
      expect(result.decided).toBe(false);
      expect(result.coalesced).toBe(false);
      // Nobody answered, and the call still came back. The point of the verb.
      expect(Date.now() - started).toBeLessThan(2_000);

      // The record is real: listable, and decidable by the existing verbs.
      const listed = broker.listApprovals();
      expect(listed.map((entry) => entry.id)).toContain(result.approval.id);
      const approved = await broker.resolveApproval(result.approval.id, {
        approved: true,
        actor: 'operator',
        actorSurface: 'web',
      });
      expect(approved?.status).toBe('approved');
    } finally {
      cleanup();
    }
  });

  test('records who raised it, from the daemon\'s own view of the caller', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const result = await createApprovalRaiseHandler(broker)(
        invocation({ request: ask('call-2'), metadata: { source: 'settings-modal' } }),
      ) as { approval: { metadata: Record<string, unknown> } };
      expect(result.approval.metadata).toMatchObject({
        source: 'settings-modal',
        raisedVia: 'approvals.raise',
        raisedByPrincipal: 'operator',
        raisedByPrincipalKind: 'user',
        raisedBySurface: 'web',
      });
    } finally {
      cleanup();
    }
  });

  test('an identical in-flight ask coalesces onto the first record — one prompt', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const handler = createApprovalRaiseHandler(broker);
      const first = await handler(invocation({ request: ask('call-3'), sessionId: 's1' })) as {
        approval: { id: string };
      };
      const second = await handler(invocation({ request: ask('call-4'), sessionId: 's1' })) as {
        approval: { id: string }; coalesced: boolean;
      };
      expect(second.coalesced).toBe(true);
      expect(second.approval.id).toBe(first.approval.id);
      expect(broker.listApprovals().filter((entry) => entry.status === 'pending')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('waitMs returns the DECIDED record when an answer lands inside the window', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const handler = createApprovalRaiseHandler(broker);
      // Answer as soon as the record appears, which is what a live surface does.
      const unsubscribe = broker.subscribe((approval) => {
        if (approval.status !== 'pending') return;
        void broker.resolveApproval(approval.id, { approved: true, actor: 'operator', actorSurface: 'web' });
      });
      const result = await handler(invocation({ request: ask('call-5'), waitMs: 5_000 })) as {
        approval: { status: string }; decided: boolean;
      };
      unsubscribe();
      expect(result.decided).toBe(true);
      expect(result.approval.status).toBe('approved');
    } finally {
      cleanup();
    }
  });

  test('a waitMs that runs out reports the still-pending record, never a decision nobody made', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const result = await createApprovalRaiseHandler(broker)(
        invocation({ request: ask('call-6'), waitMs: 25 }),
      ) as { approval: { status: string }; decided: boolean };
      expect(result.decided).toBe(false);
      expect(result.approval.status).toBe('pending');
    } finally {
      cleanup();
    }
  });

  test('a malformed ask is refused at the door, naming the field', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const handler = createApprovalRaiseHandler(broker);
      let field: string | undefined;
      try {
        await handler(invocation({ request: { ...ask('call-7'), category: 'not-a-category' } }));
      } catch (error) {
        if (isGatewayVerbError(error)) field = error.field;
      }
      expect(field).toBe('request.category');
      expect(broker.listApprovals()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe('approval-update — the push that replaces polling', () => {
  interface Frame { readonly event: string; readonly payload: unknown }

  /** A WS client, with the handshake noise dropped. Captures event AND payload. */
  function connect(gateway: ControlPlaneGateway, domains?: readonly RuntimeEventDomain[]): Frame[] {
    const received: Frame[] = [];
    gateway.openWebSocketClient(
      { clientKind: 'web', ...(domains ? { domains: [...domains] } : {}) },
      (event, payload) => { received.push({ event, payload }); },
    );
    received.length = 0;
    return received;
  }

  function approvalFrames(frames: readonly Frame[]): { readonly approval: { status: string; id: string; request: { tool: string } } }[] {
    return frames
      .filter((frame) => frame.event === 'approval-update')
      .map((frame) => frame.payload as { approval: { status: string; id: string; request: { tool: string } } });
  }

  test('a raised ask reaches a permissions-domain subscriber as approval-update', async () => {
    const { broker, cleanup } = makeBroker();
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    try {
      broker.setPublisher(gateway);
      const permissionsSub = connect(gateway, ['permissions']);
      const sessionOnlySub = connect(gateway, ['session']);

      await createApprovalRaiseHandler(broker)(invocation({ request: ask('call-8') }));

      const pushed = approvalFrames(permissionsSub);
      expect(pushed).toHaveLength(1);
      // The FIRST push carries the pending ask itself, that push IS the prompt.
      expect(pushed[0]?.approval.status).toBe('pending');
      expect(pushed[0]?.approval.request.tool).toBe('exec');
      // Domain narrowing still narrows: this is a real filter, not a broadcast.
      expect(approvalFrames(sessionOnlySub)).toHaveLength(0);
    } finally {
      broker.setPublisher(null);
      cleanup();
    }
  });

  test('the decision transition is pushed too, so the raiser never has to poll', async () => {
    const { broker, cleanup } = makeBroker();
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    try {
      broker.setPublisher(gateway);
      const result = await createApprovalRaiseHandler(broker)(invocation({ request: ask('call-9') })) as {
        approval: { id: string };
      };
      const sub = connect(gateway, ['permissions']);
      await broker.resolveApproval(result.approval.id, { approved: false, actor: 'operator', actorSurface: 'web' });

      const pushed = approvalFrames(sub);
      expect(pushed.map((entry) => entry.approval.status)).toContain('denied');
      expect(pushed.every((entry) => entry.approval.id === result.approval.id)).toBe(true);
    } finally {
      broker.setPublisher(null);
      cleanup();
    }
  });

  test('the event is cataloged, so a client can subscribe against a contract instead of guessing', () => {
    const descriptor = builtinGatewayEventDescriptors.find((entry) => entry.id === 'control.approval_update');
    expect(descriptor).toBeDefined();
    expect(descriptor?.wireEvents).toEqual(['approval-update']);
    expect(descriptor?.domains).toEqual(['permissions']);
    expect(descriptor?.transport).toEqual(['sse', 'ws']);
    // The descriptor's domain must be the one the fan-out actually enforces.
    expect(EVENT_DOMAIN['approval-update']).toBe('permissions');
  });
});

describe('the in-process path still resolves', () => {
  test('requestApproval still resolves with the decision', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      const pending = broker.requestApproval({ request: ask('call-10') as never });
      // Answer once the record exists.
      await Bun.sleep(20);
      const record = broker.listApprovals()[0]!;
      await broker.resolveApproval(record.id, { approved: true, actor: 'operator', actorSurface: 'tui' });
      await expect(pending).resolves.toMatchObject({ approved: true });
    } finally {
      cleanup();
    }
  });

  test('a localPrompt still answers the ask it created, and a coalesced ask does not prompt twice', async () => {
    const { broker, cleanup } = makeBroker();
    try {
      let prompts = 0;
      const localPrompt = async (): Promise<{ approved: boolean }> => {
        prompts += 1;
        return { approved: true };
      };
      const first = broker.requestApproval({ request: ask('call-11') as never, sessionId: 's2', localPrompt });
      const second = broker.requestApproval({ request: ask('call-12') as never, sessionId: 's2', localPrompt });
      await expect(first).resolves.toMatchObject({ approved: true });
      await expect(second).resolves.toMatchObject({ approved: true });
      expect(prompts).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('approvals.raise descriptor', () => {
  test('is write-scoped and ws-only, alongside the decide verbs', () => {
    const descriptor = builtinGatewayControlCoreMethodDescriptors.find((entry) => entry.id === 'approvals.raise');
    expect(descriptor).toBeDefined();
    expect(descriptor?.scopes).toEqual(['write:approvals']);
    expect(descriptor?.category).toBe('approvals');
    expect(descriptor?.transport).toEqual(['ws']);
    expect(descriptor?.http).toBeUndefined();
    expect(descriptor?.inputSchema?.['required']).toEqual(['request']);
  });
});
