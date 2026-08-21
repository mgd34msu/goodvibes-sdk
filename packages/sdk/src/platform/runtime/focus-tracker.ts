/**
 * focus-tracker.ts, tracks whether the terminal window a surface draws into
 * currently has OS-level input focus.
 *
 * The signal arrives over the terminal focus-reporting protocol (DECSET
 * ?1004h, which a host enables at terminal setup). InputTokenizer
 * (platform/core/tokenizer.ts) parses the resulting focus-in / focus-out
 * escape sequences into `{ type: 'focus', action }` tokens; a host feeds those
 * tokens here, and this is the single place they land.
 *
 * Honest degradation: a terminal that does not implement focus reporting (or a
 * multiplexer that swallows the sequences) never sends focus tokens. In that
 * case `isFocused()` stays `null` forever, "unknown", never a guessed
 * `true`/`false`. Callers that gate a user-facing behavior on focus (see
 * alert-gating.ts) must treat `null` the same as "not focused" per the
 * fallback rule: alerts fire when the terminal is definitely unfocused OR when
 * focus was never observed.
 */
export class FocusTracker {
  private focused: boolean | null = null;

  /** True/false once at least one focus token has arrived; null if none ever has. */
  isFocused(): boolean | null {
    return this.focused;
  }

  /** Called from the input pipeline on every focus token. */
  setFocused(value: boolean): void {
    this.focused = value;
  }

  /**
   * The alert-gating rule shared by every unfocused-alert notifier: fire
   * when the terminal is known to be unfocused, or when focus was never
   * observed (honest fallback, never silently suppress on an unknown
   * terminal). Only `isFocused() === true` (a real, observed focus-in with
   * no observed focus-out since) suppresses an alert.
   */
  shouldAlertWhenUnfocused(): boolean {
    return this.focused !== true;
  }
}
