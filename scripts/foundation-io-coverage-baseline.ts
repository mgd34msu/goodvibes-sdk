// foundation-io-coverage-baseline.ts
//
// The baseline for the typed-IO coverage ratchet enforced by
// check-foundation-io-coverage.ts (mirrors line-cap-grandfather.ts).
//
// packages/contracts/src/generated/foundation-client-types.ts holds the
// OperatorMethodInputMap / OperatorMethodOutputMap entries. A method id absent
// from those maps resolves to the broad `unknown` fallback in
// OperatorMethodInput/Output, so a consumer gets no compile-time shape for it.
// This number is how many operator method ids currently lack full typed IO.
//
// THE RATCHET: growth is forbidden. New operator methods must ship with typed
// IO entries so this count never rises. When typed coverage IMPROVES, lower this
// number to lock the gain in (check-foundation-io-coverage.ts fails on a stale,
// too-high baseline for the same reason line-cap fails on a stale grandfather
// entry).
//
// THE DEBT IS NOW ZERO. The grandfathered 97 were never a per-verb backlog: the
// entries are rendered from method-catalog descriptors, so
// scripts/generate-foundation-io-entries.ts emits all 443 mechanically and
// check-foundation-io-types.ts diffs all 443 against those same schemas. At 0
// this ratchet says what it should, every catalogued verb carries typed IO, and
// a verb that ships without one fails the gate instead of joining a backlog.
//
// Baseline captured after every catalogued verb gained rendered typed-IO
// entries (2026-07): 443 operator method ids, 443 fully typed, 0 untyped.
export const FOUNDATION_IO_COVERAGE_BASELINE = 0;
