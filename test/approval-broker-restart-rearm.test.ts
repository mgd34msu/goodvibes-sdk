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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from './_helpers/test-timeout.js';
import { ApprovalBroker } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { SharedApprovalStatus } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.js';

function request(callId: string, args: Record<string, unknown> = { merchant: 'shop.example' }): PermissionPromptRequest {
  return {
    callId,
    tool: 'payments.purchase',
    args,
    category: 'execute',
    analysis: {
      classification: 'payment',
      riskLevel: 'high',
      summary: 'Buy a burr coffee grinder for USD 120.00',
      reasons: ['above the daily item budget'],
    },
  };
}

/**
 * Args that will not coalesce onto another ask in the same store.
 *
 * `requestApproval` merges an identical concurrent ask — same session, tool and
 * args — into the existing pending record instead of creating a second one. A
 * witness record built from the default args would therefore not exist at all,
 * and the tests below would be waiting on something that was never created.
 */
const WITNESS_ARGS = { merchant: 'witness.example' } as const;

function makeStorePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-rearm-'));
  return {
    path: join(dir, 'approvals.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Just the fields these tests read or rewrite; the round-trip keeps the rest. */
interface PersistedApproval {
  readonly callId: string;
  expiresAt?: number;
}
interface PersistedSnapshot {
  readonly approvals: readonly PersistedApproval[];
}

function readStore(storePath: string): PersistedSnapshot | null {
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8')) as PersistedSnapshot;
  } catch {
    // Not written yet. `persist()` renames into place, so a read never sees a
    // half-written file — only an absent one.
    return null;
  }
}

/**
 * True once `callId` is in the STORE FILE.
 *
 * A restart reads the file, and `requestApproval` puts the record in memory
 * before it writes it, so `listApprovals()` says yes while the store is still
 * empty. Every test here used to bridge that gap with `setTimeout(…, 20)`,
 * which is a bet on how quickly two fsyncs and a rename complete; on a 2-vCPU
 * runner under the full suite the bet lost and the restarted broker loaded an
 * empty store, reporting `undefined` for a record the test had just created.
 *
 * Waiting on the file is waiting on the thing the restart actually consumes.
 */
function persisted(storePath: string, callId: string): boolean {
  return readStore(storePath)?.approvals.some((entry) => entry.callId === callId) ?? false;
}

/**
 * Move a persisted deadline, which is what the passage of time would do to it.
 *
 * The deadline has to be a known distance from the restart for these tests to
 * mean anything — "still in the future" and "already passed" are the two cases
 * the sweep branches on. Deriving it from a `timeoutMs` handed to
 * `requestApproval` makes it a distance from the CREATE instead, so how long
 * the create took decides which case the test exercises. Writing it here, one
 * `readFile` before the restart consumes it, makes the case a fact.
 *
 * It also means no record in these tests carries a live timer on the first
 * broker: nothing fires mid-suite into a temp directory the test has removed.
 */
function setPersistedDeadline(storePath: string, callId: string, expiresAt: number): void {
  const snapshot = readStore(storePath);
  const record = snapshot?.approvals.find((entry) => entry.callId === callId);
  if (!snapshot || !record) throw new Error(`no persisted approval for ${callId}`);
  record.expiresAt = expiresAt;
  writeFileSync(storePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * How far past the restart a deadline written by `setPersistedDeadline` sits.
 *
 * The only work between writing it and the restarted broker reading it is one
 * `readFile` of a small JSON file, so this is not a padding guess in the way a
 * `setTimeout` before an assertion is: nothing waits this long on a green run
 * unless the deadline itself is what is being waited for, and the tests below
 * assert WHICH sweep branch ran, so a window that was somehow too small fails
 * by name instead of quietly testing the other case.
 */
const REARM_WINDOW_MS = 250;

const REARMED_NOTE = 'timed out after a restart re-armed its deadline';

function statusOf(broker: ApprovalBroker, callId: string): SharedApprovalStatus | undefined {
  return broker.listApprovals().find((entry) => entry.callId === callId)?.status;
}

function expiryNote(broker: ApprovalBroker, callId: string): string | undefined {
  return broker.listApprovals()
    .find((entry) => entry.callId === callId)
    ?.audit.find((entry) => entry.action === 'expired')?.note;
}

/**
 * Put a record in the store that the re-arm sweep MUST settle, and wait for it.
 *
 * Two of the tests below assert that the sweep LEAVES A RECORD ALONE. Polling
 * for "still pending" answers instantly and would answer the same way before
 * the sweep had run at all, so on its own it proves nothing — it is the shape
 * of assertion that the fixed sleeps were already failing to make honest. This
 * gives the sweep a second record it cannot ignore, waits for that one to be
 * settled, and only then is "unchanged" a statement about a sweep that has
 * demonstrably executed and drained the async expiry it kicks off.
 */
async function witnessSweepRan(broker: ApprovalBroker, callId: string): Promise<void> {
  await waitFor(() => statusOf(broker, callId) === 'expired');
  expect(expiryNote(broker, callId)).toBe(REARMED_NOTE);
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
      const pending = first.requestApproval({ request: request('call-2') });
      void pending.catch(() => undefined);
      await waitFor(() => persisted(store.path, 'call-2'));

      // The deadline is written into the store rather than counted from the
      // create, so "still in its window when the restart reads it" is a
      // property of the file and not of how busy the machine was.
      setPersistedDeadline(store.path, 'call-2', Date.now() + REARM_WINDOW_MS);

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();

      // Still inside its window immediately after the restart …
      expect(statusOf(second, 'call-2')).toBe('pending');

      // … and the re-armed timer settles it rather than leaving it forever.
      await waitFor(() => statusOf(second, 'call-2') === 'expired');
      // WHICH branch settled it is the whole claim. A sweep that expired it on
      // sight also reads 'expired' here, and would be the opposite defect —
      // an approval killed while it still had time left to be answered.
      expect(expiryNote(second, 'call-2')).toBe(REARMED_NOTE);
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
      await waitFor(() => persisted(store.path, 'call-3'));

      // A second ask, with a deadline, that the sweep has to settle. Creating
      // it only after call-3 is on disk keeps the two writes from overlapping,
      // so neither one's snapshot can land on top of the other's.
      void first.requestApproval({ request: request('call-3-witness', WITNESS_ARGS) }).catch(() => undefined);
      await waitFor(() => persisted(store.path, 'call-3-witness'));
      setPersistedDeadline(store.path, 'call-3-witness', Date.now() + REARM_WINDOW_MS);

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();
      await witnessSweepRan(second, 'call-3-witness');

      // No deadline was ever set, so there is nothing to re-arm and nothing to
      // expire. It stays pending, correctly, until something answers it — and
      // the witness above is what makes that a statement about a sweep that
      // ran, rather than about one that had not reached this record yet.
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
      void first.requestApproval({ request: request('call-4') }).catch(() => undefined);
      // The create's write has to be COMPLETE before the resolve's write
      // starts. Both persist the whole store, so two in flight at once are a
      // last-writer-wins race, and the loser is the create — it carries the
      // 'pending' snapshot taken before the record was answered. On the CI
      // runner it landed second and the restarted broker read back an approval
      // that had already been approved as still pending.
      await waitFor(() => persisted(store.path, 'call-4'));
      const created = first.listApprovals().find((entry) => entry.callId === 'call-4');
      expect(created).toBeDefined();
      await first.resolveApproval(created?.id as string, {
        approved: true,
        actor: 'tester',
        actorSurface: 'tui',
      });

      void first.requestApproval({ request: request('call-4-witness', WITNESS_ARGS) }).catch(() => undefined);
      await waitFor(() => persisted(store.path, 'call-4-witness'));

      // A deadline that has ALREADY passed is the case with teeth: it is the
      // one a sweep that did not check status would re-expire the moment it
      // loaded, turning a purchase somebody approved into a denial. With a
      // deadline still in the future the sweep would merely arm a timer for
      // later, and this test would go green over a broker that was wrong.
      setPersistedDeadline(store.path, 'call-4', Date.now() - 1);
      setPersistedDeadline(store.path, 'call-4-witness', Date.now() + REARM_WINDOW_MS);

      const second = new ApprovalBroker({ storePath: store.path });
      await second.start();
      await witnessSweepRan(second, 'call-4-witness');

      expect(statusOf(second, 'call-4')).toBe('approved');
    } finally {
      store.cleanup();
    }
  });
});

describe('the audit trail names the surface that actually answered', () => {
  test('a local prompt records the calling surface, not a hardcoded tui', async () => {
    const store = makeStorePath();
    try {
      const broker = new ApprovalBroker({ storePath: store.path });
      await broker.start();
      await broker.requestApproval({
        request: request('call-5'),
        localPrompt: async () => ({ approved: true, remember: false }),
        localPromptSurface: 'agent-terminal',
        localPromptActor: 'agent-local',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const record = broker.listApprovals().find((entry) => entry.callId === 'call-5');
      expect(record?.status).toBe('approved');
      expect(record?.resolvedBy).toBe('agent-local');
      // "Which surface approved this purchase" is a question the payment audit
      // record has to answer truthfully; a hardcoded 'tui' made it a lie for
      // every product that is not the TUI.
      const approvedEntry = record?.audit.find((entry) => entry.action === 'approved');
      expect(approvedEntry?.actorSurface).toBe('agent-terminal');
    } finally {
      store.cleanup();
    }
  });

  test('a caller that says nothing keeps the historical tui labelling', async () => {
    const store = makeStorePath();
    try {
      const broker = new ApprovalBroker({ storePath: store.path });
      await broker.start();
      await broker.requestApproval({
        request: request('call-6'),
        localPrompt: async () => ({ approved: true, remember: false }),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const record = broker.listApprovals().find((entry) => entry.callId === 'call-6');
      expect(record?.resolvedBy).toBe('tui-local');
    } finally {
      store.cleanup();
    }
  });
});
