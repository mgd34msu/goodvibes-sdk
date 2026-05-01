export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function yieldEvery(index: number, interval = 8): Promise<void> {
  if (index > 0 && index % interval === 0) await yieldToEventLoop();
}
