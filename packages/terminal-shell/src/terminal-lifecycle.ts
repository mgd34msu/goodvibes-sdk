/**
 * terminal-lifecycle.ts — shared terminal enter/restore sequencing for GoodVibes
 * daemon front-ends.
 *
 * Both front-ends drive a full-screen terminal UI and must enter and later
 * restore the terminal identically. When these sequences diverge between them,
 * exit teardown leaves the wrong screen active or wipes the user's scrollback —
 * a defect class that recurs whenever the two copies drift. This module is the
 * single home for the escape sequences and the enter/restore ordering, so both
 * front-ends share one implementation.
 *
 * What lives here is only the terminal-state sequencing and the restored-state
 * gate. The graceful application shutdown (draining services, persisting
 * sessions, exit codes) is front-end-specific and stays in each app's own
 * process-lifecycle wiring; that wiring calls `restoreTerminal()` from this
 * module for the synchronous terminal hand-back.
 */

/**
 * The canonical control sequences the shell writes to enter and leave terminal
 * mode (alt screen, mouse, cursor, keyboard-extension, paste, and focus
 * reporting). Shared verbatim so the two front-ends cannot drift on the bytes.
 */
export const TERMINAL_ESCAPES = {
  ALT_SCREEN_ENTER: '\x1b[?1049h',
  ALT_SCREEN_EXIT: '\x1b[?1049l',
  MOUSE_ENABLE: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  MOUSE_DISABLE: '\x1b[?1006l\x1b[?1002l\x1b[?1000l',
  CURSOR_HIDE: '\x1b[?25l',
  CURSOR_SHOW: '\x1b[?25h',
  KEYBOARD_EXT_ENABLE: '\x1b[>4;2m\x1b[?1u',
  KEYBOARD_EXT_DISABLE: '\x1b[>4;0m\x1b[?1l',
  PASTE_ENABLE: '\x1b[?2004h',
  PASTE_DISABLE: '\x1b[?2004l',
  FOCUS_ENABLE: '\x1b[?1004h',
  FOCUS_DISABLE: '\x1b[?1004l',
  /**
   * Clear viewport + home the cursor, WITHOUT ESC[3J. The 3J form wipes the
   * user's PRIMARY-screen scrollback on several emulators; the restore path
   * must never use it. Used by the no-alt-screen restore path.
   */
  CLEAR_VIEWPORT_HOME: '\x1b[2J\x1b[H',
} as const;

export type TerminalEscapes = typeof TERMINAL_ESCAPES;

/**
 * The subset of escape sequences the enter/restore paths compose. Defaults to
 * TERMINAL_ESCAPES; overridable only for tests that assert exact byte output.
 */
export interface TerminalSequenceSet {
  readonly ALT_SCREEN_ENTER: string;
  readonly ALT_SCREEN_EXIT: string;
  readonly MOUSE_ENABLE: string;
  readonly MOUSE_DISABLE: string;
  readonly CURSOR_HIDE: string;
  readonly CURSOR_SHOW: string;
  readonly KEYBOARD_EXT_ENABLE: string;
  readonly KEYBOARD_EXT_DISABLE: string;
  readonly PASTE_ENABLE: string;
  readonly PASTE_DISABLE: string;
  readonly FOCUS_ENABLE: string;
  readonly FOCUS_DISABLE: string;
  readonly CLEAR_VIEWPORT_HOME: string;
}

export interface TerminalLifecycleDeps {
  /** Raw write to the terminal output stream (typically stdout.write bound). */
  readonly write: (data: string) => void;
  /**
   * Whether the alt screen is skipped. Mirrors the front-end's --no-alt-screen
   * flag: when true, enter never switches to the alt screen and restore clears
   * the primary viewport (without 3J) instead of leaving the alt screen.
   */
  readonly noAltScreen: boolean;
  /**
   * Wrap the restore write so it is not suppressed by an output guard. When a
   * front-end installs a stdout guard, restore must still reach the real
   * terminal. Defaults to calling the write directly.
   */
  readonly guardedWrite?: (write: () => void) => void;
  /**
   * Dispose the front-end's terminal output guard, if any. Called AFTER the
   * restore write so a crash stack reaches the real stderr instead of being
   * suppressed by the guard. No-op by default.
   */
  readonly disposeOutputGuard?: () => void;
  /**
   * Set raw mode on the input stream. Called last during restore; wrapped in a
   * try/catch because stdin may not be a TTY. No-op by default.
   */
  readonly setRawMode?: (enabled: boolean) => void;
  /** Escape sequences; defaults to the shared TERMINAL_ESCAPES. */
  readonly escapes?: TerminalSequenceSet;
}

export interface TerminalLifecycle {
  /**
   * Compose and write the enter sequence: alt-screen (unless noAltScreen),
   * clear + home, hide cursor, then enable mouse / keyboard-extension / paste /
   * focus reporting. Idempotent-safe to call once at startup.
   */
  readonly enterTerminal: () => void;
  /**
   * Idempotent, synchronous-only terminal restore. Safe to call from
   * process 'exit', signal handlers, uncaughtException, and the graceful exit
   * path. Disposes the output guard AFTER the restore write so a crash stack
   * still reaches the real stderr.
   */
  readonly restoreTerminal: () => void;
  /**
   * True once restoreTerminal has run. The compositor must never write another
   * frame after this: the terminal is back on the user's primary screen, and a
   * late cursor-positioned frame (async shutdown races, stray timers) would
   * paint over shell content and strand the prompt mid-screen. Wire the render
   * scheduler's `isReleased` to this.
   */
  readonly isTerminalRestored: () => boolean;
}

/**
 * Build the shared terminal lifecycle around a front-end's injected terminal
 * I/O. Behavior mirrors the reference front-end exactly: enter switches to the
 * alt screen (unless disabled) and enables the input modes; restore leaves the
 * alt screen (or clears the primary viewport without 3J), shows the cursor on
 * the screen the shell prompt lands on, then hands input back.
 */
export function createTerminalLifecycle(deps: TerminalLifecycleDeps): TerminalLifecycle {
  const escapes = deps.escapes ?? TERMINAL_ESCAPES;
  const guardedWrite = deps.guardedWrite ?? ((write: () => void): void => write());
  const disposeOutputGuard = deps.disposeOutputGuard ?? ((): void => {});
  const setRawMode = deps.setRawMode ?? ((): void => {});

  const enterTerminal = (): void => {
    guardedWrite(() =>
      deps.write(
        (deps.noAltScreen ? '' : escapes.ALT_SCREEN_ENTER)
        + escapes.CLEAR_VIEWPORT_HOME
        + escapes.CURSOR_HIDE
        + escapes.MOUSE_ENABLE
        + escapes.KEYBOARD_EXT_ENABLE
        + escapes.PASTE_ENABLE
        + escapes.FOCUS_ENABLE,
      ),
    );
  };

  let terminalRestored = false;
  const restoreTerminal = (): void => {
    if (terminalRestored) return;
    terminalRestored = true;
    // Alt-screen path: just leave the alt screen — 1049l restores the primary
    // screen and cursor exactly as they were at launch. Clearing first is
    // pointless (the alt screen is discarded) and actively harmful: a clear
    // with ESC[3J wipes the PRIMARY scrollback on several emulators even when
    // issued from the alt screen.
    // No-alt path: the compositor painted over the primary screen, so clear
    // the viewport and home the cursor — but WITHOUT 3J, the user's scrollback
    // is theirs. CURSOR_SHOW goes AFTER the screen switch so visibility
    // applies to the screen the shell prompt lands on.
    const exitScreen = deps.noAltScreen ? escapes.CLEAR_VIEWPORT_HOME : escapes.ALT_SCREEN_EXIT;
    guardedWrite(() =>
      deps.write(
        escapes.PASTE_DISABLE + escapes.KEYBOARD_EXT_DISABLE + escapes.MOUSE_DISABLE + escapes.FOCUS_DISABLE
        + exitScreen + escapes.CURSOR_SHOW,
      ),
    );
    // Dispose the guard AFTER the restore write so a crash stack reaches the
    // real stderr instead of being suppressed by the guard.
    disposeOutputGuard();
    try { setRawMode(false); } catch { /* input stream may not be a TTY */ }
  };

  return {
    enterTerminal,
    restoreTerminal,
    isTerminalRestored: () => terminalRestored,
  };
}
