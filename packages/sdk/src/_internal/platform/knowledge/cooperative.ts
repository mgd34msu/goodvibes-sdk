export async function yieldToEventLoop(): Promise<void> {
  await sleep(0);
}

export async function yieldEvery(index: number, interval = 8): Promise<void> {
  if (index > 0 && index % interval === 0) await yieldToEventLoop();
}

export function scheduleBackground(
  callback: () => void,
  delayMs = 0,
  signal?: AbortSignal,
): ReturnType<typeof setTimeout> {
  let abort = (): void => {};
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    if (!signal?.aborted) callback();
  }, Math.max(0, delayMs));
  abort = (): void => clearTimeout(timer);
  if (signal?.aborted) clearTimeout(timer);
  else signal?.addEventListener('abort', abort, { once: true });
  timer.unref?.();
  return timer;
}

export async function sleep(delayMs: number, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
  if (options.signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, Math.max(0, delayMs));
    options.signal?.addEventListener('abort', done, { once: true });
    timer.unref?.();
  });
}
