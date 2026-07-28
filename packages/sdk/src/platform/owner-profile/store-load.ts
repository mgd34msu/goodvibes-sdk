/**
 * store-load.ts — getting the profile's bytes off disk, and deciding what they are.
 *
 * Split out of store.ts (line cap) and cohesive on its own terms: everything
 * here is about the file, and nothing here touches the store's state. What the
 * store does with the answer — build a projection, swap it in, report a load
 * state — stays there.
 *
 * Both readers exist deliberately, and the pair is the point:
 *
 *  - {@link readProfile} is the reload path. The watcher has an event loop to
 *    run on and a reload must never block one.
 *  - {@link readProfileSync} is the BOOT path. A daemon composition root is
 *    synchronous, and an async initial load left a window in which the profile
 *    existed but had not been read yet. Inside it every verb answered "your
 *    profile has not been loaded yet" — which docs/owner-profile.md §4.4 does
 *    not sanction as a state — and, with nothing logged, the config fallback
 *    answered UNSET for `checkin.quietHours` and the open-tier block rendered
 *    empty. A readiness promise could not have closed that half:
 *    `ConfigManager.get()` is synchronous, so a fallback reader has nothing to
 *    await with. Reading the file once, synchronously, at boot removes the
 *    window rather than making it awaitable. It is one small file, on a path
 *    that already reads settings.json the same way.
 *
 * They share {@link decodeProfileBytes} so the one judgement that matters —
 * that bytes which are not valid UTF-8 are unavailable WITH A REASON rather
 * than silently loaded as mojibake — cannot drift between them.
 */
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { summarizeError } from '../utils/error-display.js';

/** The mtime/size pair a write compares against to notice a concurrent edit. */
export interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

/** A missing file is a real state (zeros), not an error. */
export function statOf(path: string): FileStat {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * What one read of the profile found.
 *
 * `missing` is separate from `error` because the two mean opposite things to
 * the owner: a file that is not there yet is an honest empty profile — "you
 * have not told me anything" — while a file that cannot be read is a failure
 * he needs to be told about, with the reason.
 */
export type ProfileReadResult =
  | { readonly kind: 'text'; readonly text: string; readonly seen: FileStat }
  | { readonly kind: 'missing'; readonly seen: FileStat }
  | { readonly kind: 'error'; readonly cause: string };

/**
 * Decode bytes as UTF-8, fatally.
 *
 * Fatal rather than replacement characters: a UTF-16 mis-save decodes to
 * plausible-looking mojibake under a lenient decoder, and the profile would
 * then load "successfully" full of garbage instead of saying it cannot be read.
 * Round-tripping the bytes is the only honest check.
 *
 * The cause is stated here rather than passed through from the runtime: Node
 * says "The encoded data was not valid for encoding utf-8" and Bun says
 * "invalid byte sequence", and he should read the same sentence either way —
 * one that names the encoding, since "saved as UTF-16" is the accident behind
 * almost every occurrence.
 */
export function decodeProfileBytes(bytes: Buffer, seen: FileStat): ProfileReadResult {
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), seen };
  } catch (error) {
    return { kind: 'error', cause: `its bytes are not valid UTF-8 (${summarizeError(error)})` };
  }
}

/**
 * Stat BEFORE the read, on both paths: if the file changes while it is being
 * read, this baseline is the older one, so the next write notices and reloads
 * rather than believing its projection is current.
 */
export async function readProfile(path: string): Promise<ProfileReadResult> {
  const seen = statOf(path);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing', seen } : { kind: 'error', cause: summarizeError(error) };
  }
  return decodeProfileBytes(bytes, seen);
}

/** {@link readProfile}, synchronously, for the one call that cannot await. */
export function readProfileSync(path: string): ProfileReadResult {
  const seen = statOf(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing', seen } : { kind: 'error', cause: summarizeError(error) };
  }
  return decodeProfileBytes(bytes, seen);
}
