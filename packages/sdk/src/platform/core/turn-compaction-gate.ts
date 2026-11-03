/** Serializes history replacement at checkpoints owned by the active turn. */
export class TurnCompactionGate {
  private readonly pending: Array<() => Promise<void>> = [];
  private draining: Promise<void> | null = null;
  private request: AbortController | null = null;

  public get busy(): boolean {
    return this.pending.length > 0 || this.draining !== null;
  }

  public enqueue<T>(compact: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try { resolve(await compact()); } catch (error) { reject(error); }
      });
    });
    // Interrupt only generation. Started tools must settle before history moves.
    this.request?.abort();
    return result;
  }

  public async checkpoint(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.pending.length === 0) return;
    // Defer execution until draining is assigned, including synchronous callbacks.
    this.draining = Promise.resolve().then(async () => {
      while (this.pending.length > 0) await this.pending.shift()!();
    });
    try { await this.draining; } finally { this.draining = null; }
    // An enqueue can land between the drain's last iteration and its release.
    if (this.pending.length > 0) await this.checkpoint();
  }

  public async runRequest<T>(
    turnSignal: AbortSignal | undefined,
    chat: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ status: 'completed'; value: T } | { status: 'interrupted' }> {
    turnSignal?.throwIfAborted();
    if (this.busy) return { status: 'interrupted' };
    const request = new AbortController();
    this.request = request;
    const signal = turnSignal ? AbortSignal.any([turnSignal, request.signal]) : request.signal;
    try {
      const value = await chat(signal);
      turnSignal?.throwIfAborted();
      // A provider that ignores abort must not commit its stale response either.
      return request.signal.aborted ? { status: 'interrupted' } : { status: 'completed', value };
    } catch (error) {
      if (request.signal.aborted && !turnSignal?.aborted) return { status: 'interrupted' };
      throw error;
    } finally {
      this.request = null;
    }
  }
}
