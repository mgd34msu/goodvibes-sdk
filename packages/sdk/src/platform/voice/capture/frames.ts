/**
 * frames.ts — the arithmetic between a device and a consumer.
 *
 * Everything here is pure and shared, because every one of these conversions is
 * a place where a mistake is SILENT rather than loud:
 *
 *  - a recorder hands over byte chunks whose length has nothing to do with a
 *    frame size (a pipe read is whatever the kernel had), so frames must be
 *    re-cut rather than assumed — {@link AudioFrameSlicer};
 *  - the classifier was trained on int16 magnitudes, so audio scaled to -1..1
 *    scores near zero forever and looks exactly like a microphone that is not
 *    picking anything up — {@link pcm16ToFloatSamples};
 *  - speech-to-text needs a container, and a WAV header with the wrong byte
 *    order or a stale length field transcribes as silence rather than failing.
 */

/** Bytes per sample in the 16-bit PCM every recorder here is asked for. */
export const PCM16_BYTES_PER_SAMPLE = 2;

/** The int16 full-scale magnitude, the scale detector frames carry. */
export const PCM16_FULL_SCALE = 32_768;

/**
 * Decode little-endian signed 16-bit PCM into the float MAGNITUDES the wake
 * front end expects (-32768..32767), not normalised -1..1 values.
 */
export function pcm16ToFloatSamples(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.length / PCM16_BYTES_PER_SAMPLE);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const lo = bytes[i * 2] ?? 0;
    const hi = bytes[i * 2 + 1] ?? 0;
    const raw = (hi << 8) | lo;
    // Two's complement: 0x8000..0xFFFF are the negative half.
    out[i] = raw >= 0x8000 ? raw - 0x10000 : raw;
  }
  return out;
}

/** Encode float magnitudes back to little-endian signed 16-bit PCM, clamping. */
export function floatSamplesToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * PCM16_BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-PCM16_FULL_SCALE, Math.min(PCM16_FULL_SCALE - 1, Math.round(samples[i] ?? 0)));
    const raw = value < 0 ? value + 0x10000 : value;
    out[i * 2] = raw & 0xff;
    out[i * 2 + 1] = (raw >> 8) & 0xff;
  }
  return out;
}

/**
 * Root-mean-square level of a frame, on the int16 magnitude scale. Used for
 * silence detection, which is why it is not normalised: the threshold constants
 * that read it are stated in the same units the frames carry.
 */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Re-cuts an arbitrary stream of samples into fixed-size frames.
 *
 * A recorder's stdout arrives in whatever sizes the pipe produced, and a browser
 * worklet delivers 128-sample render quanta. Neither is the 1280 samples the
 * wake engine requires per call, and handing it a short frame does not fail — it
 * shifts the whole front end off the framing the classifier was trained at. So
 * the remainder is CARRIED, never dropped and never padded.
 */
export class AudioFrameSlicer {
  readonly #frameSamples: number;
  #pending: Float32Array;
  #pendingLength = 0;

  constructor(frameSamples: number) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new Error(`[capture] frameSamples must be a positive integer, got ${frameSamples}`);
    }
    this.#frameSamples = frameSamples;
    // Two frames of headroom: a chunk usually straddles at most one boundary.
    this.#pending = new Float32Array(frameSamples * 2);
  }

  /** Samples per emitted frame. */
  get frameSamples(): number {
    return this.#frameSamples;
  }

  /** Samples held back because they do not yet complete a frame. */
  get pendingSamples(): number {
    return this.#pendingLength;
  }

  /** Drop the carried remainder. Called when a stream restarts. */
  reset(): void {
    this.#pendingLength = 0;
  }

  /**
   * Add samples and return every whole frame they completed, in order. Each
   * returned frame is its own Float32Array, so a consumer may retain it (the
   * wake pre-roll buffer does) without the next chunk overwriting it.
   */
  push(samples: Float32Array): Float32Array[] {
    this.#ensureCapacity(this.#pendingLength + samples.length);
    this.#pending.set(samples, this.#pendingLength);
    this.#pendingLength += samples.length;
    const frames: Float32Array[] = [];
    let offset = 0;
    while (this.#pendingLength - offset >= this.#frameSamples) {
      frames.push(this.#pending.slice(offset, offset + this.#frameSamples));
      offset += this.#frameSamples;
    }
    if (offset > 0) {
      this.#pending.copyWithin(0, offset, this.#pendingLength);
      this.#pendingLength -= offset;
    }
    return frames;
  }

  #ensureCapacity(needed: number): void {
    if (needed <= this.#pending.length) return;
    const grown = new Float32Array(Math.max(needed, this.#pending.length * 2));
    grown.set(this.#pending.subarray(0, this.#pendingLength));
    this.#pending = grown;
  }
}

/** Concatenate frames into one buffer. */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const WAV_HEADER_BYTES = 44;

/**
 * Wrap float magnitudes in a 16-bit PCM WAV container.
 *
 * WAV rather than the browser's native webm/opus for one reason: this is the one
 * encoding both surfaces can produce from raw frames without a codec, and a
 * host-captured stream has no container of its own. Written by hand because the
 * header is 44 fixed bytes and pulling a dependency in for it would put a
 * codec's release cadence in front of the microphone path.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number, channels = 1): Uint8Array {
  const pcm = floatSamplesToPcm16(samples);
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  const byteRate = sampleRate * channels * PCM16_BYTES_PER_SAMPLE;
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * PCM16_BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64-encode bytes without `Buffer` or `btoa`.
 *
 * Hand-written because this module is imported by a browser bundle AND by a
 * daemon child process: `Buffer` does not exist in one, and `btoa` needs a
 * binary string built first, which for a ten-second clip is a 320 kB
 * intermediate. Encoding straight from the bytes avoids both.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}
