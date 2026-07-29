/**
 * checkin/receipts.ts
 *
 * The receipt store: every check-in run appends one CheckinReceipt, so the
 * automatic behavior always leaves a visible, durable trail of what it did (ran
 * and stayed quiet / delivered what / skipped why). Newest-first reads, capped
 * history, over the same PersistentStore snapshot pattern the other registries
 * use.
 */
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type { CheckinReceipt } from './types.js';

const MAX_RECEIPTS = 500;

interface CheckinReceiptsSnapshot extends Record<string, unknown> {
  version: 1;
  receipts: CheckinReceipt[];
}

function validateSnapshot(snapshot: CheckinReceiptsSnapshot | null): CheckinReceiptsSnapshot {
  if (!snapshot) return { version: 1, receipts: [] };
  if (snapshot.version !== 1 || !Array.isArray(snapshot.receipts)) {
    throw new Error('Check-in receipts store snapshot is invalid.');
  }
  return { version: 1, receipts: snapshot.receipts };
}

export class CheckinReceiptStore {
  private readonly store: PersistentStore<CheckinReceiptsSnapshot>;
  private receipts: CheckinReceipt[] | null = null;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(path: string) {
    this.store = new PersistentStore<CheckinReceiptsSnapshot>(path);
  }

  private async all(): Promise<CheckinReceipt[]> {
    if (this.receipts === null) this.receipts = validateSnapshot(await this.store.load()).receipts;
    return this.receipts;
  }

  /**
   * Append a receipt (capped to the most recent MAX_RECEIPTS).
   *
   * The write is ORDERED against every other append. A check-in run is long —
   * it reads a state snapshot, asks a model to judge it, and delivers over a
   * channel — so the scheduled run and the manual verb overlap readily, and
   * `PersistentStore.persist` is atomic but says nothing about which of two
   * in-flight writes lands last. Unordered, the earlier run's write could land
   * second and replace the file with its own snapshot, which does not contain
   * the later run's receipt. The receipt is the whole point of this store: it is
   * how an automatic behavior stays visible, so losing one means a check-in that
   * contacted the owner with nothing on disk saying it ever ran.
   */
  async append(receipt: CheckinReceipt): Promise<CheckinReceipt> {
    const receipts = await this.all();
    receipts.push(receipt);
    if (receipts.length > MAX_RECEIPTS) receipts.splice(0, receipts.length - MAX_RECEIPTS);
    const snapshot: CheckinReceiptsSnapshot = { version: 1, receipts: [...receipts] };
    await this.writes.run(() => this.store.persist(snapshot));
    return receipt;
  }

  /** Return receipts newest-first, optionally limited. */
  async list(limit?: number): Promise<CheckinReceipt[]> {
    const receipts = [...(await this.all())].sort((a, b) => b.ranAt - a.ranAt);
    return typeof limit === 'number' && limit > 0 ? receipts.slice(0, limit) : receipts;
  }
}
