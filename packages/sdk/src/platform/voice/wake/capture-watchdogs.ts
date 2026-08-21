/**
 * capture-watchdogs.ts, the bounds that turn silence into a report.
 *
 * Every one of these exists because something had NO bound and therefore no
 * failure: a start that never settled left the listener in `starting` forever,
 * and an open stream that delivered nothing looked exactly like a quiet room.
 * Unbounded waiting is not patience, it is an outcome nobody is ever told about.
 */

/** Default bound on a start that neither succeeds nor fails. */
export const START_TIMEOUT_MS = 15_000;

/**
 * Default bound on an open stream that has delivered no audio.
 *
 * Frames arrive every 80 ms, so seconds of nothing is not slowness, it is a
 * recorder that is not reading the device.
 */
export const FIRST_FRAME_TIMEOUT_MS = 5_000;

/**
 * How stale the last frame may be before "listening" stops being true.
 *
 * Generous next to the 80 ms cadence: this decides what a status surface
 * CLAIMS, and flickering between listening and not on one late frame would be
 * its own kind of lie.
 */
export const FRAMES_FLOWING_STALE_MS = 2_000;
