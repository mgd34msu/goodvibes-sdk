export const EVENT_SETTLE_MS = Number(process.env['SETTLE_MS'] ?? 50);

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  }
  throw new Error(`Timed out waiting for test predicate after ${timeoutMs}ms`);
}

export async function settleEvents(ms = EVENT_SETTLE_MS): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function withTestTimeout<T>(promise: Promise<T>, timeoutMs = 1_000, message?: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message ?? `Timed out after ${timeoutMs}ms`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function installFrozenNow(nowMs: number): () => void {
  const originalDateNow = Date.now;
  Date.now = () => nowMs;
  return () => {
    Date.now = originalDateNow;
  };
}

type ConsoleCaptureMethod = 'debug' | 'error' | 'log' | 'warn';

export function captureConsole(method: ConsoleCaptureMethod): { readonly messages: unknown[][]; restore(): void } {
  const original = console[method];
  const messages: unknown[][] = [];
  console[method] = ((...args: unknown[]) => {
    messages.push(args);
  }) as typeof console[typeof method];
  return {
    messages,
    restore(): void {
      console[method] = original;
    },
  };
}
