/**
 * waiting-wording.ts — the honest waiting-state WORDING contract, extracted
 * from `goodvibes-tui` src/renderer/ui-factory.ts:554-584 (the phrase-selection
 * branch inside createThinkingFragment; the companion :522-552
 * computeStallInfo/computeRenderStallInfo signal computation stays
 * renderer-local — each renderer has its own stream-metrics shape to derive
 * a WaitingState from).
 *
 * The split this hoists is a DATA/pure-function contract: a renderer decides
 * WHICH state it is in (from its own approval/stall/reconnect signals, in the
 * TUI's precedence order — approval beats reconnect beats pre-first-token
 * beats stalled beats thinking) and calls waitingPhrase(state, ctx) for the
 * exact wording. Neither renderer should carry its own copy of these five
 * strings/rotation — that duplication is exactly what the W4-R1 audit found
 * (the agent's ui-factory.ts:308-313 was rotating-only, with no honest
 * stall/reconnect/approval split at all).
 *
 * PURE — no fs, no terminal I/O, no timers. Gradient color, spinner glyph,
 * tok/s and elapsed-time suffixes stay renderer-owned (ui-factory.ts's
 * createThinkingFragment composes those around the phrase this returns).
 */

import { THINKING_PHRASES } from './thinking-phrases.js';

/** Frame cadence the 'thinking' rotation advances at (frames tick at 80ms in
 * the TUI, so ~30s per phrase) — the TUI's PHRASE_ROTATION_FRAMES verbatim. */
const PHRASE_ROTATION_FRAMES = 375;

/**
 * The five honest waiting states, in the TUI's precedence order:
 *  - 'approval'         — a card is waiting on the USER; the turn is not
 *                          stalled and the provider is not at fault.
 *  - 'reconnecting'     — the transport is retrying after a drop.
 *  - 'pre-first-token'  — no delta yet this turn; normal for reasoning models
 *                          that think before emitting (NOT "stalled" — that
 *                          would wrongly blame the provider for ordinary
 *                          pre-token latency).
 *  - 'stalled'          — silence AFTER the stream had already started
 *                          producing tokens.
 *  - 'thinking'         — the ordinary case: tokens are flowing at a normal
 *                          cadence, show a rotating whimsical phrase.
 */
export type WaitingState = 'approval' | 'reconnecting' | 'pre-first-token' | 'stalled' | 'thinking';

/** Inputs waitingPhrase needs for the states that carry numbers. Fields
 * unused by the selected state are ignored. */
export interface WaitingPhraseContext {
  /** 'reconnecting' — the current retry attempt number. */
  readonly reconnectAttempt?: number;
  /** 'reconnecting' — the configured maximum retry attempts. */
  readonly reconnectMaxAttempts?: number;
  /** 'pre-first-token' / 'stalled' — elapsed silence since the last delta, in ms. */
  readonly msSinceLastDelta?: number;
  /** 'thinking' — the render frame counter driving the phrase rotation. */
  readonly frame?: number;
}

/**
 * waitingPhrase — the state -> wording mapping, golden-matched against the
 * TUI's ui-factory.ts:554-584 output for identical inputs.
 */
export function waitingPhrase(state: WaitingState, ctx: WaitingPhraseContext = {}): string {
  switch (state) {
    case 'approval':
      // An approval card is waiting on the user — blame-free, precedence over
      // stall/reconnect framing: waiting on the user is the true state.
      return 'Waiting for your approval';
    case 'reconnecting':
      return `Reconnecting (attempt ${ctx.reconnectAttempt ?? 0}/${ctx.reconnectMaxAttempts ?? 0})...`;
    case 'pre-first-token':
      return `Waiting for model ${Math.floor((ctx.msSinceLastDelta ?? 0) / 1000)}s...`;
    case 'stalled':
      return `Stalled ${Math.floor((ctx.msSinceLastDelta ?? 0) / 1000)}s...`;
    case 'thinking': {
      const frame = ctx.frame ?? 0;
      const phraseIndex = Math.floor(frame / PHRASE_ROTATION_FRAMES) % THINKING_PHRASES.length;
      // phraseIndex is always in [0, THINKING_PHRASES.length) — the modulo above
      // guarantees an in-bounds index; the non-null assertion only satisfies
      // noUncheckedIndexedAccess and is never actually unsound.
      return THINKING_PHRASES[phraseIndex]!;
    }
  }
}
