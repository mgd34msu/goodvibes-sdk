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

  constructor(path: string) {
    this.store = new PersistentStore<CheckinReceiptsSnapshot>(path);
  }

  private async all(): Promise<CheckinReceipt[]> {
    if (this.receipts === null) this.receipts = validateSnapshot(await this.store.load()).receipts;
    return this.receipts;
  }

  /** Append a receipt (capped to the most recent MAX_RECEIPTS). */
  async append(receipt: CheckinReceipt): Promise<CheckinReceipt> {
    const receipts = await this.all();
    receipts.push(receipt);
    if (receipts.length > MAX_RECEIPTS) receipts.splice(0, receipts.length - MAX_RECEIPTS);
    await this.store.persist({ version: 1, receipts: [...receipts] });
    return receipt;
  }

  /** Return receipts newest-first, optionally limited. */
  async list(limit?: number): Promise<CheckinReceipt[]> {
    const receipts = [...(await this.all())].sort((a, b) => b.ranAt - a.ranAt);
    return typeof limit === 'number' && limit > 0 ? receipts.slice(0, limit) : receipts;
  }
}
