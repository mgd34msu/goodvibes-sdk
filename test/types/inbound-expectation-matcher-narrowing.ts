/**
 * Compile-time pin for §12 gate #35's type half: the inbound path cannot
 * register or hydrate an expectation.
 *
 * The runtime half lives in `inbound-mail-expectation-registry.test.ts` — the
 * matcher's own-key set is exactly `matchCandidate` and `consumeMatch`, and it
 * is a plain object rather than the book. But a runtime check cannot observe a
 * type, and the type is where the guarantee is first enforced: `registry
 * .matcher` is declared as `ExpectationMatcher`, so a call to `openExpectation`
 * from inbound code does not compile, and never reaches the point where any
 * runtime assertion could catch it.
 *
 * Resolved through the BUILT declarations rather than the package name, unlike
 * the other files here, and deliberately not through `src`.
 *
 * `ExpectationMatcher` is internal wiring and is not on the package's export
 * map: importing it through `@pellux/goodvibes-sdk` would mean publishing a
 * subpath for it, which would make the very seam this gate narrows part of the
 * public surface. Reaching into `src` instead does not work either — it drags
 * the whole implementation tree into this project, which has no `node` types
 * and no DOM lib, and buries the one assertion under three hundred
 * `Cannot find name 'Buffer'` errors. `dist/**.d.ts` is self-contained, is what
 * every consumer actually type-checks against, and carries the narrowing
 * exactly as shipped.
 *
 * Checked by `bun run types:check`, which runs after the build.
 */
import type {
  ExpectationMatcher,
  InboundExpectationRegistry,
} from '../../packages/sdk/dist/platform/email/inbound/expectation-registry.js';
import type { VerificationMatch } from '../../packages/sdk/dist/platform/google/verification-expectations.js';

declare const matcher: ExpectationMatcher;
declare const candidate: Parameters<ExpectationMatcher['matchCandidate']>[0];
declare const now: Date;

// The two verbs the inbound path is entitled to, and they type-check.
export async function readTheBook(): Promise<VerificationMatch> {
  const match = await matcher.matchCandidate(candidate, now);
  await matcher.consumeMatch(match);
  return match;
}

// @ts-expect-error the inbound path cannot register an expectation
export const cannotOpen: unknown = matcher.openExpectation;

// @ts-expect-error the inbound path cannot revive a persisted expectation
export const cannotHydrate: unknown = matcher.hydrateExpectation;

// @ts-expect-error closing is the registry's verb, reached through `cancel`
export const cannotClose: unknown = matcher.closeExpectation;

// @ts-expect-error sweeping is the registry's verb, reached through `sweep`
export const cannotSweep: unknown = matcher.sweepExpired;

/**
 * And the narrowing is not accidentally undone by the registry handing back
 * something wider: `matcher` is declared as `ExpectationMatcher`, so this
 * assignment is what fails if it ever starts returning the book.
 */
declare const registry: InboundExpectationRegistry;
export const stillNarrowed: ExpectationMatcher = registry.matcher;

// @ts-expect-error and the wide book is NOT what comes back
export const notTheBook: { openExpectation: unknown } = registry.matcher;
