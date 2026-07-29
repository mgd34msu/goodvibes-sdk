/**
 * store-write-ordering-extras.test.ts
 *
 * Four more stores that share the unordered-write defect, none of which is a
 * plain "snapshot the map and write it" case:
 *
 *  - the distributed-runtime store, whose UNAWAITED writes are fired from
 *    ordinary list/read calls;
 *  - the check-in receipt store, an append-only log where losing a write loses
 *    the record of something the daemon did on its own initiative;
 *  - `KVState`, which hands its writer a live object rather than a copy;
 *  - the inbound-mail housekeeping disclosure log, the one store here where
 *    ordering the WRITE alone is not enough, because each write is the file's
 *    own previous contents plus one entry — so the READ has to be inside the
 *    serialised unit too.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './_helpers/test-timeout.js';
import { makeControllableStore, readOnDisk, replaceInternalStore } from './_helpers/controllable-store.js';

import { DistributedRuntimeManager } from '../packages/sdk/src/platform/runtime/remote/distributed-runtime-manager.js';
import { CheckinReceiptStore } from '../packages/sdk/src/platform/checkin/receipts.js';
import type { CheckinReceipt } from '../packages/sdk/src/platform/checkin/types.js';
import { KVState } from '../packages/sdk/src/platform/state/kv-state.js';
import { JsonFileStore } from '../packages/sdk/src/platform/state/json-file-store.js';
import { InboundMailHousekeeper } from '../packages/sdk/src/platform/email/inbound/housekeeping.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gv-${prefix}-`));
}

// ---------------------------------------------------------------------------
// The distributed-runtime store — a rejected pair request stays rejected.
// ---------------------------------------------------------------------------

interface DistributedFileShape extends Record<string, unknown> {
  readonly pairRequests: readonly { readonly id: string; readonly status: string }[];
}

describe('distributed runtime store — a rejected pair request does not read back pending', () => {
  test("the pairing request's own slower write cannot undo the rejection", async () => {
    const { store, path, cleanup } = makeControllableStore<DistributedFileShape>('distributed-order', 'distributed.json');
    try {
      const manager = new DistributedRuntimeManager(store as never);
      await manager.start();

      // The request's write is the slow one. The record is in the map before
      // that write lands, so an operator can reject it from the pairing screen
      // while the write that created it is still in flight.
      store.delayNextMs = 250;
      const pairing = manager.requestPairing({ peerKind: 'node', label: 'unknown laptop' });
      await waitFor(() => store.started >= 2);

      const pending = manager.listPairRequests()[0];
      expect(pending?.status).toBe('pending');
      const rejected = await manager.rejectPairRequest(pending?.id as string, { actor: 'owner' });
      expect(rejected?.status).toBe('rejected');
      await pairing;
      await waitFor(() => store.finished >= 3);

      // What the daemon reads at its next start. A 'pending' request is one a
      // peer can still complete pairing against, after its owner turned it down.
      expect(readOnDisk<DistributedFileShape>(path)?.pairRequests[0]?.status).toBe('rejected');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CheckinReceiptStore — no receipt is lost.
// ---------------------------------------------------------------------------

interface ReceiptsFileShape extends Record<string, unknown> {
  readonly receipts: readonly { readonly id: string; readonly outcome: string }[];
}

function receipt(id: string, outcome: CheckinReceipt['outcome']): CheckinReceipt {
  return {
    id,
    ranAt: Date.now(),
    trigger: 'scheduled',
    outcome,
    briefingSummary: '2 running, 1 blocked',
  };
}

describe('CheckinReceiptStore — a delivered check-in leaves a receipt', () => {
  test('an earlier slower append cannot drop the receipt written after it', async () => {
    const { store, path, cleanup } = makeControllableStore<ReceiptsFileShape>('checkin-order', 'checkin-receipts.json');
    try {
      const receipts = new CheckinReceiptStore(path);
      replaceInternalStore(receipts, 'store', store);

      // A check-in run reads a state snapshot, asks a model to judge it and
      // delivers over a channel, so the scheduled run and the manual verb
      // overlap readily — and the earlier one's snapshot does not contain the
      // later one's receipt.
      store.delayNextMs = 250;
      const first = receipts.append(receipt('checkin-quiet', 'quiet'));
      await waitFor(() => store.started >= 1);

      await receipts.append(receipt('checkin-delivered', 'delivered'));
      await first;
      await waitFor(() => store.finished >= 2);

      // The receipt is the whole point of this store: it is how an automatic
      // behavior stays visible. A missing one is a check-in that contacted the
      // owner with nothing on disk saying it ever ran.
      const onDisk = readOnDisk<ReceiptsFileShape>(path)?.receipts ?? [];
      expect(onDisk.map((entry) => entry.id)).toEqual(['checkin-quiet', 'checkin-delivered']);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// KVState — a cleared key does not come back on the next session load.
// ---------------------------------------------------------------------------

/**
 * The same knob as the ControllableStore, over `JsonFileStore` — which is what
 * KVState writes through. The capture is taken before the delay for the same
 * reason: KVState hands its writer the LIVE data object, so a real slow write
 * is slow after its bytes exist.
 */
class SlowJsonFileStore extends JsonFileStore<Record<string, unknown>> {
  delayNextMs = 0;
  started = 0;
  finished = 0;

  override async save(data: Record<string, unknown>): Promise<void> {
    this.started += 1;
    const delay = this.delayNextMs;
    this.delayNextMs = 0;
    const captured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    try {
      if (delay > 0) await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
      await super.save(captured);
    } finally {
      this.finished += 1;
    }
  }
}

describe('KVState — a cleared key does not come back', () => {
  test('a debounced write already in flight cannot restore a key cleared after it', async () => {
    const dir = tempDir('kv-order');
    const path = join(dir, 'session_abcdef12.json');
    try {
      const slow = new SlowJsonFileStore(path);
      const kv = new KVState({ sessionId: 'abcdef12', stateDir: dir });
      replaceInternalStore(kv, 'store', slow);
      await kv.load();

      await kv.set({ deploy_token: 'value-the-agent-was-told-to-forget' });
      await kv.persist();

      // Two writers, and nothing ordered them: the 5-second debounce armed by
      // set/clear, and dispose(), which clears the timer and writes directly.
      // Clearing a timer that has ALREADY fired stops nothing.
      slow.delayNextMs = 250;
      const inFlight = kv.persist();
      await waitFor(() => slow.started >= 2);

      await kv.clear(['deploy_token']);
      await kv.persist();
      await inFlight;
      await waitFor(() => slow.finished >= 3);

      // What a resumed session reads back.
      const resumed = new KVState({ sessionId: 'abcdef12', stateDir: dir });
      await resumed.load();
      expect(await resumed.get(['deploy_token'])).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// InboundMailHousekeeper — every sweep's reap reaches the disclosure log.
// ---------------------------------------------------------------------------

interface DisclosureFileShape extends Record<string, unknown> {
  readonly reports: readonly { readonly trigger: string }[];
}

function fakeSweepers(): {
  cursors: { sweep: () => Promise<unknown> };
  records: { sweep: () => Promise<unknown> };
  expectations: { sweep: () => Promise<unknown> };
} {
  const now = Date.now();
  return {
    cursors: { sweep: async () => ({ sweptAt: now, removed: [], retained: 1, unresolvedAccounts: 0 }) },
    // Something is actually reaped, so there is something to disclose.
    records: { sweep: async () => ({ sweptAt: now, removed: [{ reason: 'past-retention' }], retained: 4 }) },
    expectations: { sweep: async () => ({ sweptAt: now, removed: [], retained: 0, survivors: [] }) },
  };
}

describe('InboundMailHousekeeper — no sweep goes undisclosed', () => {
  test('two overlapping sweeps both appear in the log', async () => {
    const { store, path, cleanup } = makeControllableStore<DisclosureFileShape>('housekeeping-order', 'inbound-housekeeping.json');
    try {
      const fakes = fakeSweepers();
      const housekeeper = new InboundMailHousekeeper({
        cursors: fakes.cursors as never,
        records: fakes.records as never,
        expectations: fakes.expectations as never,
        disclosurePath: path,
      });
      replaceInternalStore(housekeeper, 'disclosure', store);

      // The recovery sweep runs on `supervisor.start()`, which a config change
      // re-runs; the periodic sweep runs on a 6-hour timer. Each one READS the
      // log and writes it back with its own entry appended, so overlapping them
      // makes the second read a copy that does not have the first entry in it.
      store.delayNextMs = 250;
      const recovery = housekeeper.sweep('recovery');
      await waitFor(() => store.started >= 1);

      await housekeeper.sweep('periodic');
      await recovery;
      await waitFor(() => store.finished >= 2);

      // Files were removed on both passes. A missing entry is a reap with
      // nothing anywhere saying it happened — which is the one thing this log
      // exists to prevent.
      expect((readOnDisk<DisclosureFileShape>(path)?.reports ?? []).map((entry) => entry.trigger))
        .toEqual(['recovery', 'periodic']);
    } finally {
      cleanup();
    }
  });
});
