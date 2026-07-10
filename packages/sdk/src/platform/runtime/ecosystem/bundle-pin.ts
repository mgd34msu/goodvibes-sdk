/**
 * bundle-pin.ts
 *
 * SHA-256-pinned bundle distribution. A bundle is fetched from a source
 * (file / URL / git) and its bytes are verified against an EXPECTED SHA-256 pin
 * BEFORE the bundle is ever activated. The refusal is hard and structural:
 *
 *   - a source with no pin           → refused (cannot be represented as trusted)
 *   - a source whose bytes mismatch  → refused (no "install anyway" path)
 *
 * This is the postinstall-checksum lesson made load-bearing: verification is not
 * an advisory step a caller can skip; `fetchAndVerifyBundle` throws before it
 * returns bytes unless the pin matches. All three source kinds resolve to the
 * SAME byte space, so one pin convention (hex SHA-256 of the fetched bytes)
 * governs every source — no split hash spaces.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A pinned bundle source. `sha256` is REQUIRED — an unpinned source is invalid. */
export interface PinnedBundleSource {
  readonly kind: 'file' | 'url' | 'git';
  /** File path, URL, or git remote (for `git`, combined with `ref`). */
  readonly location: string;
  /** Expected hex SHA-256 of the fetched bytes. Lowercase, 64 hex chars. */
  readonly sha256: string;
  /** Git ref (tag/commit/branch) to archive. Required for `kind: 'git'`. */
  readonly ref?: string | undefined;
}

/** Injectable IO so the fetch path is testable without the network or git. */
export interface BundleFetchDeps {
  /** Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Produce deterministic archive bytes for a git source. Defaults to
   * `git archive --format=tar <ref> --remote=<location>`. Injected in tests.
   */
  readonly gitArchive?: ((location: string, ref: string) => Uint8Array) | undefined;
}

/** Result of comparing fetched bytes to an expected pin. */
export type PinVerification =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: string; readonly expected: string; readonly actual?: string | undefined };

const HEX64 = /^[0-9a-f]{64}$/;

/** Hex SHA-256 of a byte buffer. */
export function computeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verify fetched bytes against an expected pin. A missing/malformed pin is a
 * failure in its own right — the absence of a pin is never "acceptable".
 */
export function verifyBundleBytes(bytes: Uint8Array, expectedSha256: string): PinVerification {
  const expected = (expectedSha256 ?? '').toLowerCase();
  if (!HEX64.test(expected)) {
    return { ok: false, reason: 'missing or malformed SHA-256 pin (need 64 lowercase hex chars)', expected };
  }
  const actual = computeSha256(bytes);
  if (actual !== expected) {
    return { ok: false, reason: 'SHA-256 pin mismatch', expected, actual };
  }
  return { ok: true, sha256: actual };
}

/** Raised when a bundle is refused because its pin is missing or mismatched. */
export class BundlePinRefusal extends Error {
  constructor(
    readonly source: PinnedBundleSource,
    readonly verification: Extract<PinVerification, { ok: false }>,
  ) {
    super(
      `Refused to activate bundle from ${source.kind} source '${source.location}': ${verification.reason}` +
        (verification.actual ? ` (expected ${verification.expected}, got ${verification.actual})` : ''),
    );
    this.name = 'BundlePinRefusal';
  }
}

function resolveBytes(source: PinnedBundleSource, deps: BundleFetchDeps): Uint8Array | Promise<Uint8Array> {
  switch (source.kind) {
    case 'file':
      return new Uint8Array(readFileSync(source.location));
    case 'git': {
      const ref = source.ref;
      if (!ref) throw new Error(`git source '${source.location}' requires a 'ref' (tag/commit) to pin against`);
      const archive =
        deps.gitArchive ??
        ((location: string, gitRef: string): Uint8Array =>
          new Uint8Array(
            execFileSync('git', ['archive', '--format=tar', `--remote=${location}`, gitRef], {
              maxBuffer: 256 * 1024 * 1024,
            }),
          ));
      return archive(source.location, ref);
    }
    case 'url': {
      const fetchImpl = deps.fetchImpl ?? fetch;
      return fetchImpl(source.location).then(async (res) => {
        if (!res.ok) throw new Error(`URL source '${source.location}' returned HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      });
    }
  }
}

/**
 * Fetch a pinned bundle and verify its pin BEFORE returning. Throws
 * `BundlePinRefusal` on any missing/mismatched pin — there is no path that
 * yields bytes for an unverified source.
 */
export async function fetchAndVerifyBundle(
  source: PinnedBundleSource,
  deps: BundleFetchDeps = {},
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const bytes = await resolveBytes(source, deps);
  const verification = verifyBundleBytes(bytes, source.sha256);
  if (!verification.ok) {
    throw new BundlePinRefusal(source, verification);
  }
  return { bytes, sha256: verification.sha256 };
}
