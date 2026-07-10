// Contract artifacts are generated from package source and committed so release
// packages can expose stable JSON contracts without running generators at
// install time. This script is the CI/local check-mode wrapper for that refresh.
if (!process.argv.includes('--check')) {
  process.argv.push('--check');
}

await import('./refresh-contract-artifacts.ts');

// refresh-contract-artifacts.ts never touches
// packages/contracts/src/generated/foundation-client-types.ts (it only
// regenerates operator-contract/operator-method-ids/peer-contract/
// peer-endpoint-ids/foundation-metadata) — that file is emitted by
// scripts/export-foundation-artifacts.ts, which is absent from this repo
// (an unrecoverable-source decision: hand-authored fallback with a
// mandatory consistency check). Run that check here so `contracts:check`
// stays the one gate that catches drift in either generated surface.
await import('./check-foundation-io-types.ts');

// The typed-IO coverage ratchet: check-foundation-io-types.ts above proves the
// hand-authored entries don't DRIFT from their schemas; this proves the set of
// methods with NO typed IO doesn't GROW. Same gate (`contracts:check`).
await import('./check-foundation-io-coverage.ts');
