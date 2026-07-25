/**
 * Daemon receipts: one-line, human-readable records of daemon-side events
 * that happened while no surface was watching ("updated from X to Y at
 * HH:MM", "restarted after a crash at HH:MM").
 *
 * Each receipt is written to the daemon log the moment it is recorded, and
 * persisted so the NEXT surface that explicitly consumes sees it exactly
 * once: a /status read that passes `?receipts=consume` receives undelivered
 * receipts and marks them delivered. A plain /status read (identity probe,
 * keepalive, version poll) neither receives nor consumes receipts, so a
 * non-rendering reader can never eat one before a rendering surface.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { isRecord } from '../utils/record-coerce.js';

export interface DaemonReceipt {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly deliveredAt?: number | undefined;
}

export interface ReceiptStoreIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
}

export const realReceiptStoreIo: ReceiptStoreIo = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null),
  write: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf-8');
  },
};

const MAX_KEPT_RECEIPTS = 50;

/**
 * The age bound the count cap alone does not give. A receipt says "here is what
 * the daemon did while you were not looking"; a fortnight later nobody is going
 * to act on it, and on a quiet daemon the 50-slot cap would otherwise hold
 * month-old lines forever because nothing new ever pushed them out. Fourteen
 * days comfortably spans a holiday-length absence while still being a bound.
 */
const MAX_RECEIPT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** What a load found on disk: the usable receipts plus what the file cost us. */
interface ParsedReceiptFile {
  readonly receipts: DaemonReceipt[];
  /** The file existed but was not parseable JSON, or was not a JSON array at all. */
  readonly unreadable: boolean;
  /** Entries present in a parseable file that were not well-formed receipts. */
  readonly droppedEntries: number;
}

function parseReceipts(raw: string | null): ParsedReceiptFile {
  if (raw === null) return { receipts: [], unreadable: false, droppedEntries: 0 };
  // An empty/whitespace-only file is the classic torn write: the file was
  // created (or truncated) and the process died before the content landed.
  if (!raw.trim()) return { receipts: [], unreadable: true, droppedEntries: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { receipts: [], unreadable: true, droppedEntries: 0 };
  }
  if (!Array.isArray(parsed)) return { receipts: [], unreadable: true, droppedEntries: 0 };
  const receipts = parsed.filter((entry): entry is DaemonReceipt =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.text === 'string'
    && typeof entry.at === 'number');
  return { receipts, unreadable: false, droppedEntries: parsed.length - receipts.length };
}

/** Formats a timestamp as the local HH:MM wall-clock time for receipt text. */
export function formatReceiptTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export class DaemonReceiptStore {
  private readonly io: ReceiptStoreIo;
  private readonly now: () => number;
  private receipts: DaemonReceipt[];

  constructor(
    private readonly path: string,
    options: { io?: ReceiptStoreIo; now?: () => number } = {},
  ) {
    this.io = options.io ?? realReceiptStoreIo;
    this.now = options.now ?? Date.now;

    // Recovery-time housekeeping, disclosed rather than silent. A crash can
    // leave this file torn, truncated or half-written; reading it as "no
    // receipts" and then overwriting it on the next record() would erase the
    // user's receipt history with nothing to show for it. Say what was lost.
    const loaded = parseReceipts(this.io.read(this.path));
    if (loaded.unreadable) {
      logger.warn('[daemon-receipt] receipt file was unreadable — starting from an empty receipt history', {
        path: this.path,
      });
    } else if (loaded.droppedEntries > 0) {
      logger.warn('[daemon-receipt] discarded malformed receipt entries', {
        path: this.path,
        droppedEntries: loaded.droppedEntries,
        keptReceipts: loaded.receipts.length,
      });
    }

    const bounded = this.applyBounds(loaded.receipts);
    this.receipts = bounded.receipts;
    if (bounded.expired > 0) {
      logger.info('[daemon-receipt] retired receipts past their age bound', {
        path: this.path,
        expiredReceipts: bounded.expired,
        keptReceipts: this.receipts.length,
      });
      // Make the reap durable, but never let a read-only/unwritable store
      // break construction — the in-memory list is already correct.
      try {
        this.persist();
      } catch (error) {
        logger.warn('[daemon-receipt] could not persist the age-bound reap', {
          path: this.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Both bounds in one place: drop receipts older than MAX_RECEIPT_AGE_MS, then
   * keep at most MAX_KEPT_RECEIPTS (newest last, so the cap drops the oldest).
   * Idempotent — running it on an already-bounded list changes nothing.
   */
  private applyBounds(receipts: readonly DaemonReceipt[]): { receipts: DaemonReceipt[]; expired: number } {
    const cutoff = this.now() - MAX_RECEIPT_AGE_MS;
    const fresh = receipts.filter((receipt) => receipt.at >= cutoff);
    const expired = receipts.length - fresh.length;
    return { receipts: fresh.slice(-MAX_KEPT_RECEIPTS), expired };
  }

  /** Record a receipt: logged immediately, persisted for the next surface. */
  record(text: string): DaemonReceipt {
    const receipt: DaemonReceipt = {
      id: `receipt-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      at: this.now(),
    };
    const bounded = this.applyBounds([...this.receipts, receipt]);
    this.receipts = bounded.receipts;
    if (bounded.expired > 0) {
      logger.info('[daemon-receipt] retired receipts past their age bound', {
        path: this.path,
        expiredReceipts: bounded.expired,
        keptReceipts: this.receipts.length,
      });
    }
    this.persist();
    logger.info(`[daemon-receipt] ${text}`, { receiptId: receipt.id });
    return receipt;
  }

  /** All receipts, newest last (delivered and undelivered). */
  list(): readonly DaemonReceipt[] {
    return this.receipts;
  }

  /**
   * Undelivered receipts for a consuming /status read (`?receipts=consume`);
   * marks them delivered so a receipt is surfaced to the first CONSUMING
   * reader exactly once. Callers serving a non-consuming read must not call
   * this — that is what keeps identity probes receipt-neutral.
   */
  consumeUndelivered(): readonly DaemonReceipt[] {
    const undelivered = this.receipts.filter((receipt) => receipt.deliveredAt === undefined);
    if (undelivered.length === 0) return [];
    const deliveredAt = this.now();
    const deliveredIds = new Set(undelivered.map((receipt) => receipt.id));
    this.receipts = this.receipts.map((receipt) =>
      deliveredIds.has(receipt.id) ? { ...receipt, deliveredAt } : receipt);
    this.persist();
    return undelivered;
  }

  private persist(): void {
    this.io.write(this.path, `${JSON.stringify(this.receipts, null, 2)}\n`);
  }
}
