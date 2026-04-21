/**
 * Generic fixed-capacity ring buffer (circular buffer).
 *
 * All writes are O(1). When the buffer is full the oldest entry is silently
 * evicted (FIFO). Reading all entries is O(n) where n ≤ capacity.
 *
 * This is the canonical ring-buffer utility for the SDK. Prefer this over
 * ad-hoc implementations when bounded-memory queues are needed.
 */

/**
 * A generic ring buffer with a fixed capacity.
 *
 * Entries are stored in insertion order. When the buffer is full the oldest
 * entry is overwritten (FIFO eviction). All push operations are O(1).
 */
export class RingBuffer<T> {
  private readonly _buf: (T | undefined)[];
  private _head = 0; // next-write slot
  private _count = 0; // current occupancy (≤ capacity)
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError(`RingBuffer capacity must be >= 1, got ${capacity}`);
    this.capacity = capacity;
    this._buf = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** Number of entries currently stored (≤ capacity). */
  get size(): number {
    return this._count;
  }

  /** True when the buffer holds at least one entry. */
  get isEmpty(): boolean {
    return this._count === 0;
  }

  /**
   * Push an entry into the buffer.
   *
   * If the buffer is full the oldest entry is evicted to make room.
   * Always O(1).
   */
  push(item: T): void {
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  /**
   * Return all entries in insertion order (oldest → newest).
   *
   * Allocates a new array of length `size` per call.
   */
  toArray(): T[] {
    if (this._count === 0) return [];
    const result = new Array<T>(this._count);
    const oldest = this._count < this.capacity ? 0 : this._head;
    for (let i = 0; i < this._count; i++) {
      result[i] = this._buf[(oldest + i) % this.capacity] as T;
    }
    return result;
  }

  /**
   * Return the N most recent entries in insertion order (oldest → newest).
   *
   * If `n >= size` returns the same result as `toArray()`.
   */
  takeLast(n: number): T[] {
    if (n <= 0) return [];
    const all = this.toArray();
    return n >= all.length ? all : all.slice(all.length - n);
  }

  /**
   * Return the N most recent entries in reverse insertion order (newest → oldest).
   *
   * Useful for "latest first" display without an extra `.reverse()` call.
   */
  takeLastReversed(n: number): T[] {
    if (n <= 0) return [];
    const count = Math.min(n, this._count);
    const result = new Array<T>(count);
    for (let i = 0; i < count; i++) {
      // Walk backwards from head-1 (most recent write)
      const idx = (this._head - 1 - i + this.capacity) % this.capacity;
      result[i] = this._buf[idx] as T;
    }
    return result;
  }

  /** Remove all entries and reset internal state. Capacity is preserved. */
  clear(): void {
    this._buf.fill(undefined);
    this._head = 0;
    this._count = 0;
  }
}
