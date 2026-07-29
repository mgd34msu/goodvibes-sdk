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
