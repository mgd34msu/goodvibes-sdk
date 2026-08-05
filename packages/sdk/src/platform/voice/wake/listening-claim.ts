/**
 * listening-claim.ts — what a surface is ALLOWED to say about wake detection.
 *
 * Split out of listener.ts because it is the answer to a specific defect and
 * deserves to be found on its own: surfaces derived their listening indicator
 * from the listener's PHASE, and `starting` was mapped to "listening for the
 * wake phrase". A start that hung therefore showed a listening banner through
 * an entire boot on a machine with no capture stream, no recorder process and
 * not one line in the log. Intent is not evidence.
 *
 * Everything here is derived from capture truth — a stream being open, and
 * frames having actually arrived — so a surface rendering this cannot make that
 * claim again.
 */
import type { WakeListenerState } from './listener.js';

/**
 * What a surface may CLAIM, derived from capture truth.
 *
 * `listening` is the only kind that means audio is arriving. It exists because
 * surfaces derived their indicator from the listener's phase, and `starting`
 * was mapped to "listening for the wake phrase" — so a start that hung showed a
 * listening banner through an entire boot on a machine with no capture stream
 * at all. A surface that renders this instead of the phase cannot make that
 * claim again.
 */
export type WakeListeningClaim =
  /** A stream is open and frames are arriving. */
  | { readonly kind: 'listening'; readonly message: string }
  /** Opening. Not listening yet, and it must not be shown as if it were. */
  | { readonly kind: 'starting'; readonly message: string }
  /** A stream is open and no audio is coming through it. */
  | { readonly kind: 'no-audio'; readonly message: string }
  /** Nothing is capturing, with the reason. */
  | { readonly kind: 'not-listening'; readonly message: string };

/** Turn listener state into the claim a status surface is allowed to make. */
export function describeWakeListening(state: WakeListenerState): WakeListeningClaim {
  const device = state.deviceBinding?.device;
  const where = device !== undefined && device.length > 0 ? device : 'the system default input';
  if (state.captureOpen && state.framesFlowing) {
    return {
      kind: 'listening',
      message: state.phase === 'capturing-utterance'
        ? 'Listening — recording what you are saying.'
        : `Listening for the wake phrase on ${where}.`,
    };
  }
  if (state.captureOpen) {
    return {
      kind: 'no-audio',
      message: `The microphone is open on ${where} but no audio is arriving from it, so nothing can be heard yet.`,
    };
  }
  if (state.phase === 'starting') {
    return { kind: 'starting', message: `Opening ${where} — not listening yet.` };
  }
  if (state.phase === 'restarting') {
    return {
      kind: 'not-listening',
      message: `Capture stopped and is being restarted${state.lastError ? ` (${state.lastError})` : ''}. Nothing is listening right now.`,
    };
  }
  if (state.phase === 'latched') {
    return {
      kind: 'not-listening',
      message: `Wake detection stopped: ${state.latchReason ?? 'it failed too many times'}. Nothing is listening.`,
    };
  }
  // Idle or stopped: the device binding usually holds the most specific reason
  // (no microphone on this host, a pinned device that is not connected).
  const reason = state.deviceBinding?.state === 'no-microphone'
    ? state.deviceBinding.message
    : state.lastError ?? 'wake detection is not running';
  return { kind: 'not-listening', message: reason };
}
