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

function parseReceipts(raw: string | null): DaemonReceipt[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DaemonReceipt =>
      isRecord(entry)
      && typeof entry.id === 'string'
      && typeof entry.text === 'string'
      && typeof entry.at === 'number');
  } catch {
    return [];
  }
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
    this.receipts = parseReceipts(this.io.read(this.path));
  }

  /** Record a receipt: logged immediately, persisted for the next surface. */
  record(text: string): DaemonReceipt {
    const receipt: DaemonReceipt = {
      id: `receipt-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      at: this.now(),
    };
    this.receipts = [...this.receipts, receipt].slice(-MAX_KEPT_RECEIPTS);
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
