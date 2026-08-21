/**
 * Combine several abort signals into one.
 *
 * The clock takes a single signal and several things can end a wait, a
 * shutdown, a re-probe request, an inner race. Composed here rather than
 * threaded through every sleep, and disposed so a long-lived signal does not
 * accumulate listeners from every wait that ever used it.
 *
 * One definition rather than two. `watcher.ts` and `gmail-source.ts` each held
 * a private copy, and the copy in `gmail-source.ts` said so in a comment,
 * accepted at the time on the grounds that a three-line utility restates
 * nothing about the shape of the system. That reasoning holds for the SHAPE
 * and not for the BEHAVIOUR: the disposal half is the easy half to get subtly
 * wrong, both sources hold long-lived signals across a poll loop, and a leak
 * fixed in one copy would have stayed in the other. There is nothing here for
 * either module to disagree about, so neither gets its own version.
 */
export function anySignal(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const relay = (): void => { controller.abort(); };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', relay);
    },
  };
}
