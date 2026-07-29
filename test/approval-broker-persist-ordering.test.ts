/**
 * approval-broker-persist-ordering.test.ts
 *
 * The defect this pins: `ApprovalBroker.persist` serialised the whole store
 * from a snapshot taken when it was CALLED, and nothing ordered the writes.
 * Two in flight at once finished in whatever order their renames landed, so
 * the write that started first could finish last and put its older view of the
 * store back on disk.
 *
 * CI demonstrated it rather than anyone theorising it: the write recording a
 * new approval overlapped with the write recording the answer to that
 * approval, the create's rename landed second, and after a restart a purchase
 * somebody had approved read back as still 'pending'. An approval stuck at
 * pending is eventually a denial, so for the payment path this is the decision
 * being silently discarded — which is the one thing that path exists to keep.
 *
 * Two properties close it, and both are tested here: writes are ORDERED (via
 * StoreWriteQueue), and each write serialises the approvals as they are when
 * it RUNS rather than when it was queued, so the file converges on the map
 * instead of on whatever the caller happened to be looking at.
 */
import { describe, test, expect } from 'bun:test';
import { waitFor } from './_helpers/test-timeout.js';
import {
  makeControllableStore,
  readOnDisk,
  type ControllableStore,
} from './_helpers/controllable-store.js';
import { StoreWriteQueue } from '../packages/sdk/src/platform/state/store-write-queue.js';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { SharedApprovalRecord } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';

/**
 * `merchant` varies per call because `requestApproval` COALESCES asks that
 * match on session, tool and args — a second identical ask joins the first
 * record instead of creating its own. Tests that need two distinct pending
 * approvals have to differ somewhere, or they silently get one.
 */
function request(callId: string, merchant = 'shop.example'): PermissionPromptRequest {
  return {
    callId,
    tool: 'payments.purchase',
    args: { merchant },
    category: 'execute',
    analysis: {
      classification: 'payment',
      riskLevel: 'high',
      summary: 'Buy a burr coffee grinder for USD 120.00',
      reasons: ['above the daily item budget'],
    },
  };
}

interface ApprovalSnapshot extends Record<string, unknown> {
  readonly approvals: readonly SharedApprovalRecord[];
}

/**
 * The store harness lives in `_helpers/controllable-store.ts` — a real
 * `PersistentStore` with a delay knob and a fail-the-Nth-write knob. It was
 * written here for this defect and moved out so the other stores that share it
 * are pinned by the same technique rather than a second one.
 */
function makeStore(): {
  store: ControllableStore<ApprovalSnapshot>;
  path: string;
  cleanup: () => void;
} {
  const { store, path, cleanup } = makeControllableStore<ApprovalSnapshot>('approval-order', 'approvals.json');
  return { store, path, cleanup };
}

function onDisk(path: string, callId: string): SharedApprovalRecord | undefined {
  return readOnDisk<ApprovalSnapshot>(path)?.approvals.find((entry) => entry.callId === callId);
}

describe('the newest write is the one that survives on disk', () => {
  test('a slow create cannot put its stale snapshot back over the resolve that followed it', async () => {
    const { store, path, cleanup } = makeStore();
    try {
      const broker = new ApprovalBroker({ store });
      await broker.start();

      // The create's write is the slow one, exactly as on the runner: it
      // captured 'pending', and it is still in flight while the answer arrives.
      store.delayNextMs = 250;
      void broker.requestApproval({ request: request('call-order') }).catch(() => undefined);

      // The record is in the map before its write completes — that is the
      // whole window — so a surface can and does resolve it right here.
      await waitFor(() => broker.listApprovals().some((entry) => entry.callId === 'call-order'));
      const created = broker.listApprovals().find((entry) => entry.callId === 'call-order');
      expect(created).toBeDefined();
      await broker.resolveApproval(created?.id as string, {
        approved: true,
        actor: 'tester',
        actorSurface: 'tui',
      });

      // Wait for BOTH writes to be done before reading. Without this the test
      // would read the file while the slow create's rename was still pending
      // and pass whether or not anything was ordered.
      await waitFor(() => store.finished >= 2);

      expect(onDisk(path, 'call-order')?.status).toBe('approved');
      // And the map it is supposed to mirror agrees.
      expect(broker.listApprovals().find((entry) => entry.callId === 'call-order')?.status).toBe('approved');
    } finally {
      cleanup();
    }
  });

  test('a write that fails is the failing caller\'s problem and nobody else\'s', async () => {
    const { store, path, cleanup } = makeStore();
    try {
      const broker = new ApprovalBroker({ store });
      await broker.start();
      void broker.requestApproval({ request: request('call-isolated') }).catch(() => undefined);
      await waitFor(() => onDisk(path, 'call-isolated') !== undefined);
      const created = broker.listApprovals().find((entry) => entry.callId === 'call-isolated');

      // The resolve's write fails. The caller hears about it …
      store.failNext = true;
      await expect(broker.resolveApproval(created?.id as string, {
        approved: true,
        actor: 'tester',
        actorSurface: 'tui',
      })).rejects.toThrow('store unavailable');

      // … and the queue is still usable rather than wedged behind the
      // rejection, which is what a naive `queue = queue.then(write)` would do.
      const updated = await broker.recordRemoteUpdate(created?.id as string, { actor: 'tester' });
      expect(updated).not.toBeNull();

      // That later write serialises the map as it is now, so the resolution the
      // failed write never got to disk is on disk after the next successful
      // one. The file converges on the map; it does not stay behind it.
      expect(onDisk(path, 'call-isolated')?.status).toBe('approved');
    } finally {
      cleanup();
    }
  });

  test('a create whose write fails leaves the record in neither the map nor the file', async () => {
    const { store, path, cleanup } = makeStore();
    try {
      const broker = new ApprovalBroker({ store });
      await broker.start();

      store.failNext = true;
      await expect(broker.requestApproval({ request: request('call-rolled-back') }))
        .rejects.toThrow('store unavailable');

      expect(broker.listApprovals().some((entry) => entry.callId === 'call-rolled-back')).toBe(false);
      expect(onDisk(path, 'call-rolled-back')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('a rolled-back create is removed from the file a neighbouring write had already put it in', async () => {
    const { store, path, cleanup } = makeStore();
    try {
      const broker = new ApprovalBroker({ store });
      await broker.start();

      // A slow first write holds the queue open, so the two creates below are
      // both in the map before either of THEIR writes gets a turn.
      store.delayNextMs = 200;
      void broker.requestApproval({ request: request('call-seed', 'seed.example') }).catch(() => undefined);
      await waitFor(() => broker.listApprovals().some((entry) => entry.callId === 'call-seed'));

      // Write 2 is the doomed create's own, and it fails. Write 3 belongs to
      // the create that came after it, and its snapshot — taken when IT called
      // persist, with the doomed record already in the map — carries that
      // record to disk on the doomed create's behalf. So a create that was
      // told it failed is on disk anyway, inside somebody else's write.
      store.failWriteNumber = 2;
      const doomed = broker.requestApproval({ request: request('call-doomed', 'doomed.example') });
      void broker.requestApproval({ request: request('call-neighbour', 'neighbour.example') }).catch(() => undefined);
      await waitFor(() => broker.listApprovals().some((entry) => entry.callId === 'call-neighbour'));

      // requestApproval writes the corrected map before it rethrows, and that
      // write is queued behind the neighbour's, so observing this rejection
      // means both have landed.
      await expect(doomed).rejects.toThrow('store unavailable');
      // Belt and braces for the case where there IS no correcting write: wait
      // for the neighbour's write either way, so this reads the settled file.
      await waitFor(() => store.finished >= 3);

      expect(broker.listApprovals().some((entry) => entry.callId === 'call-doomed')).toBe(false);
      expect(onDisk(path, 'call-doomed')).toBeUndefined();
      // The neighbour that shared the write is untouched by the correction.
      expect(onDisk(path, 'call-neighbour')).toBeDefined();
      expect(onDisk(path, 'call-seed')).toBeDefined();
    } finally {
      cleanup();
    }
  });
});

describe('StoreWriteQueue orders writes and contains their failures', () => {
  test('writes run one at a time in the order they were requested', async () => {
    const queue = new StoreWriteQueue();
    const order: string[] = [];
    const write = (name: string, ms: number) => async (): Promise<void> => {
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
      order.push(`${name}:end`);
    };

    // The slow one is requested FIRST. Unordered, it would finish last.
    const slow = queue.run(write('slow', 120));
    const fast = queue.run(write('fast', 0));
    await Promise.all([slow, fast]);

    expect(order).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });

  test('one write throwing neither stops the queue nor reaches another caller', async () => {
    const queue = new StoreWriteQueue();
    const ran: string[] = [];

    const failing = queue.run(async () => {
      ran.push('failing');
      throw new Error('disk gone');
    });
    const after = queue.run(async () => {
      ran.push('after');
    });

    await expect(failing).rejects.toThrow('disk gone');
    // The later caller neither inherits the rejection nor waits forever.
    await expect(after).resolves.toBeUndefined();
    expect(ran).toEqual(['failing', 'after']);

    // And the queue is still live for whatever comes next.
    await queue.run(async () => { ran.push('later'); });
    await queue.drain();
    expect(ran).toEqual(['failing', 'after', 'later']);
  });
});
