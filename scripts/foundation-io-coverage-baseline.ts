// foundation-io-coverage-baseline.ts
//
// The grandfathered baseline for the typed-IO coverage ratchet enforced by
// check-foundation-io-coverage.ts (mirrors line-cap-grandfather.ts).
//
// packages/contracts/src/generated/foundation-client-types.ts hand-authors the
// OperatorMethodInputMap / OperatorMethodOutputMap entries (the generator that
// once emitted that file is unrecoverable — see check-foundation-io-types.ts).
// A method id absent from those maps resolves to the broad `unknown` fallback.
// This number is how many operator method ids currently lack full typed IO.
//
// THE RATCHET: growth is forbidden. New operator methods must ship with typed
// IO entries so this count never rises. It is deliberately NOT a burndown
// target here — the existing untyped methods are grandfathered; the ratchet
// only stops the debt from getting worse. When typed coverage IMPROVES (an
// existing untyped method gains entries), lower this number to lock the gain in
// (check-foundation-io-coverage.ts fails on a stale, too-high baseline for the
// same reason line-cap fails on a stale grandfather entry).
//
// Baseline captured after the checkpoints.restorePreview verb landed WITH typed
// IO entries (2026-07): 334 operator method ids, 237 fully typed, 97 untyped.
export const FOUNDATION_IO_COVERAGE_BASELINE = 97;
