export const EVENT_SETTLE_MS = Number(process.env['SETTLE_MS'] ?? 50);

/**
 * The smallest ceiling any `waitFor` is allowed to run with, and its default.
 *
 * `waitFor` is a poll-until-condition: it returns the instant the predicate
 * holds, so a LARGER ceiling costs a fast host exactly nothing — it only
 * changes how long a genuinely stuck condition takes to be reported. The small
 * numbers call sites were passing (250 ms is the common one, across 29 files
 * that use this helper) are therefore not budgets for the work; they are
 * assumptions about how promptly this process gets scheduled. Under a realistic
 * concurrent load those assumptions failed —
 * `Timed out waiting for test predicate after 250ms` — while the code under
 * test was doing exactly what it should.
 *
 * A floor is safe here because no call site uses a `waitFor` rejection as its
 * assertion; a test proving something never happens does not express that as a
 * poll that must time out. Override with GOODVIBES_TEST_WAIT_FLOOR_MS to
 * tighten it locally.
 */
const WAIT_FLOOR_MS = (() => {
  const env = Number(process.env['GOODVIBES_TEST_WAIT_FLOOR_MS']);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 5_000;
})();

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = Math.max(options.timeoutMs ?? WAIT_FLOOR_MS, WAIT_FLOOR_MS);
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

/**
 * Race a promise against a ceiling. Same reasoning as WAIT_FLOOR_MS: the
 * default was 1 000 ms, which is an idle machine's number for work this suite
 * routinely does against real sockets and real subprocesses. Explicit values
 * are respected as given — unlike waitFor, this one CAN legitimately be used to
 * bound something short — only the default moves.
 */
export async function withTestTimeout<T>(promise: Promise<T>, timeoutMs = 30_000, message?: string): Promise<T> {
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
