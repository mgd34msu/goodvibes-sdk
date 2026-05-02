export async function yieldToEventLoop(): Promise<void> {
  await sleep(0);
}

export async function yieldEvery(index: number, interval = 8): Promise<void> {
  if (index > 0 && index % interval === 0) await yieldToEventLoop();
}

export function scheduleBackground(callback: () => void, delayMs = 0): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref?.();
  return timer;
}

export async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, delayMs));
    timer.unref?.();
  });
}
