/**
 * StoreWriteQueue — one whole-file write at a time, in call order.
 *
 * `PersistentStore.persist` replaces a file atomically, so no reader ever sees
 * a torn write. It says nothing about ORDER. Two writes in flight at once
 * finish whenever their renames happen to land, so the write that STARTED
 * first can FINISH last and put its older view of the data back on disk.
 *
 * That is not a theoretical hazard. In `ApprovalBroker` the write that records
 * a new approval and the write that records the answer to it overlapped on a
 * 2-vCPU CI runner; the create's rename landed second, and its snapshot —
 * taken before the approval was answered — went back on disk on top of the
 * resolution. After a restart, a purchase somebody had approved read back as
 * still pending. For a payment approval that is the decision itself being
 * lost, and an approval left pending is eventually a denial.
 *
 * This class supplies ORDER: writes run one at a time, in the order they were
 * requested, so a write can never land on top of one requested after it.
 *
 * Order is enough on its own PROVIDED callers snapshot their state before
 * queueing, which is the normal shape — mutate, then persist. Each snapshot is
 * then at least as new as the one queued before it, and the last to land is
 * the most recent. A caller that queues a write and mutates afterwards is
 * outside what this guarantees, and wants its own write for that mutation.
 *
 * FAILURE IS ISOLATED TO THE CALLER WHOSE WRITE FAILED. `run` rejects for that
 * caller and for nobody else: the queue itself continues, and the next write
 * starts from a clean slate. This is deliberate, and it is the opposite of
 * what a naive `queue = queue.then(write)` does — there the rejection becomes
 * the queue, every later `.then` skips its handler, and one transient ENOSPC
 * wedges every future write for the life of the process. It also keeps one
 * caller's error out of another caller's `await`, which matters because these
 * callers run their own compensating logic on failure: `requestApproval` rolls
 * its approval back out of the in-memory map, and running that because
 * somebody else's write failed would delete a record that was perfectly fine.
 *
 * The queue therefore tracks COMPLETION, never OUTCOME.
 *
 * WHERE IT IS USED, AND WHAT EACH CALLER LOSES WITHOUT IT. Recorded here
 * because the rationale is one argument made about a dozen stores, and because
 * two of them are in files at their line-cap ceiling. Every line of this is
 * pinned by a test that fails when that store's queue is removed
 * (test/store-write-ordering*.test.ts):
 *
 *  - `UserPermissionRuleStore` — a remembered "always allow" decision's write
 *    overtaking the revocation that followed it. A durable user rule is
 *    consulted before anything prompts, so the revoked rule silently
 *    auto-approves again.
 *  - `DaemonBatchManager` — a tick's write, begun before an operator cancelled
 *    a job, landing after the cancel. The job reads back 'queued' and the next
 *    tick submits it to the paid provider.
 *  - `SharedSessionBroker` — the 60-second GC sweep's UNAWAITED write landing
 *    after a `cancelInput`. Boot reconciliation reads 'queued' as work waiting
 *    to be picked up and spawns an agent for cancelled work.
 *  - `ChannelPolicyManager` — the debounced audit flush, scheduled on every
 *    inbound message, landing after a policy change. A disabled surface comes
 *    back enabled, or a seeded owner allowlist comes back empty.
 *  - The four automation stores — up to `automation.maxConcurrentRuns` writers
 *    plus a 2-second reconcile timer. A completed run reads back 'running' and
 *    the reconciler executes the job again.
 *  - `TaskScheduler` — add/remove/setEnabled each fire an unawaited save. A
 *    deleted cron task comes back and spawns an agent on the next start.
 *  - `CiWatchService` — a poll's write, requested before its network round
 *    trip returned, landing after a delete. The deleted watch keeps notifying.
 *  - `PrincipalRegistry` / `ChannelProfileRegistry` — a create/set landing
 *    after the delete that followed it, so a deleted identity mapping or
 *    channel binding is still in force after a restart.
 *  - The distributed-runtime store — writes fired from ordinary list calls,
 *    unawaited. A rejected pair request reads back 'pending'.
 *  - `CheckinReceiptStore` — an append-only log where the earlier write's
 *    snapshot does not contain the later receipt, so a check-in that contacted
 *    the owner leaves nothing on disk saying it ran.
 *  - `KVState` — dispose() racing a debounce that has already fired; a cleared
 *    key comes back when the session is resumed.
 *  - `InboundMailHousekeeper`'s disclosure log — the ONE caller where ordering
 *    the write alone is not enough, because each write is the file's own
 *    previous contents plus one entry. Its READ is inside the queued unit too.
 *
 * `WorkspaceRegistrationStore` is deliberately NOT on this list. It is a
 * read-modify-write with cross-process contention, so it takes the advisory
 * lock at `PersistentStore.lockPath` as well as a chain — see that file and
 * `push/subscription-store.ts`.
 */
export class StoreWriteQueue {
  /**
   * Settles when the last queued write finishes, successfully or not.
   *
   * Only ever assigned a promise that cannot reject — that is what lets `run`
   * attach a single-argument `.then` below and know the handler will always be
   * reached, and it is why a failed write cannot strand the queue.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Run `write` once every previously queued write has finished.
   *
   * Resolves or rejects with `write`'s own outcome. A rejection here is this
   * caller's alone; the queue has already moved on.
   */
  async run(write: () => Promise<void>): Promise<void> {
    const attempt = this.queue.then(write);
    // Swallowing here is what keeps the QUEUE alive, not what hides the error:
    // `attempt` still carries the rejection to the caller awaiting it below,
    // and attaching this handler also means the rejection is never unobserved.
    this.queue = attempt.then(() => undefined, () => undefined);
    await attempt;
  }

  /** Settles when everything queued so far has finished. Test and shutdown seam. */
  async drain(): Promise<void> {
    await this.queue;
  }
}
