/**
 * single-flight.ts — collapse concurrent invocations of an async operation
 * into one in-flight execution: while a run is in progress every caller joins
 * its promise; the next call after settlement starts a fresh run.
 *
 * Used where concurrent runs are never meaningful (e.g. voice.local.install —
 * two parallel multi-hundred-MB provision runs would race the same managed
 * directory), so the second caller receives the in-progress result instead of
 * starting a duplicate.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
