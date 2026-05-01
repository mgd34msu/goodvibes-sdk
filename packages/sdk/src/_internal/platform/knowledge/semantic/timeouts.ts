export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withTimeoutOrNull<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  try {
    return await withTimeout(promise, timeoutMs, 'operation timed out');
  } catch {
    return null;
  }
}

export function clampTimeoutMs(
  value: number | undefined,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackMs;
  return Math.max(minMs, Math.min(maxMs, Math.trunc(value)));
}
