/**
 * approval-broker-restart-rearm.test.ts
 *
 * The defect this pins: `ApprovalBroker` held every expiry timer in
 * `pendingResolvers`, which is in-memory and rebuilt empty by `start()`. A
 * restart therefore left a timed approval with no timer and no recorded
 * deadline, and it sat 'pending' forever with nothing in the system that would
 * ever resolve it.
 *
 * For a tool-permission ask that is a stale row someone eventually notices. For
 * a payment approval it is money in limbo — and because silence on a payment
 * approval means DENIED, a record stuck at 'pending' is precisely the state that
 * ruling exists to prevent.
 *
 * Fixed in the broker rather than worked around per-consumer, because every
 * consumer of the broker had it.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';

function request(callId: string): PermissionPromptRequest {
  return {
    callId,
    tool: 'payments.purchase',
    args: { merchant: 'shop.example' },
    category: 'execute',
    analysis: {
      classification: 'payment',
      riskLevel: 'high',
      summary: 'Buy a burr coffee grinder for USD 120.00',
      reasons: ['above the daily item budget'],
    },
  };
}

function makeStorePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rearm-'));
  return {
    path: join(dir, 'approvals.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('an approval survives a restart with its deadline intact', () => {
  test('a deadline that passed while the process was down resolves DENIED, not pending', async () => {
    const store = makeStorePath();
    try {
      const first = new ApprovalBroker({ storePath: store.path });
      await first.start();

      // A short window, deliberately: it is already over by the time the second
      // broker starts, which is the whole scenario.
      const pending = first.requestApproval({ request: request('call-1'), timeoutMs: 40 });
      // The awaiting caller dies with the process in the real case; here it is
      // resolved by the expiry so the promise is not left dangling.
      void pending.catch(() => undefined);
      // requestApproval is async: let it create and persist the record before
      // asking the broker what it holds.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const created = first.listApprovals().find((entry) => entry.callId === 'call-1');
      expect(created?.status).toBe('pending');
      expect(created?.expiresAt).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 120));

      // A NEW broker over the same store is the restart.
      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const restored = second.listApprovals().find((entry) => entry.callId === 'call-1');
      expect(restored).toBeDefined();
      expect(restored?.status).toBe('expired');
      expect(restored?.decision?.approved).toBe(false);
    } finally {
      store.cleanup();
    }
  });

  test('a deadline still in the future is re-armed and fires after the restart', async () => {
    const store = makeStorePath();
    try {
      const first = new ApprovalBroker({ storePath: store.path });
      await first.start();
      const pending = first.requestApproval({ request: request('call-2'), timeoutMs: 400 });
      void pending.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();

      // Still inside its window immediately after the restart …
      expect(second.listApprovals().find((entry) => entry.callId === 'call-2')?.status).toBe('pending');

      // … and the re-armed timer settles it rather than leaving it forever.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(second.listApprovals().find((entry) => entry.callId === 'call-2')?.status).toBe('expired');
    } finally {
      store.cleanup();
    }
  });

  test('an approval with no timeout is left alone by the re-arm sweep', async () => {
    const store = makeStorePath();
    try {
      const first = new ApprovalBroker({ storePath: store.path });
      await first.start();
      void first.requestApproval({ request: request('call-3') }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();
      await new Promise((resolve) => setTimeout(resolve, 60));

      // No deadline was ever set, so there is nothing to re-arm and nothing to
      // expire. It stays pending, correctly, until something answers it.
      const restored = second.listApprovals().find((entry) => entry.callId === 'call-3');
      expect(restored?.status).toBe('pending');
      expect(restored?.expiresAt).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });

  test('an already-resolved approval is not re-expired by the sweep', async () => {
    const store = makeStorePath();
    try {
      const first = new ApprovalBroker({ storePath: store.path });
      await first.start();
      void first.requestApproval({ request: request('call-4'), timeoutMs: 5_000 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const created = first.listApprovals().find((entry) => entry.callId === 'call-4');
      expect(created).toBeDefined();
      await first.resolveApproval(created?.id as string, {
        approved: true,
        actor: 'tester',
        actorSurface: 'tui',
      });

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(second.listApprovals().find((entry) => entry.callId === 'call-4')?.status).toBe('approved');
    } finally {
      store.cleanup();
    }
  });
});
