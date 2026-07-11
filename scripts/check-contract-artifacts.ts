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

// The published OpenAPI 3.1 operator contract is generated from the committed
// operator-contract.json (plus the typed-client-IO ratchet inputs, so the
// untyped methods stay honestly marked). Same gate, same idiom: drift in
// packages/contracts/artifacts/operator-openapi.json or
// docs/operator-openapi.json reddens `contracts:check`.
await import('./generate-openapi-contract.ts');

// The generated consumer transport layers (Stage C): the webui mechanical
// facade (packages/contracts/src/generated/webui-facade.ts) and the Home
// Assistant Python client (packages/contracts/artifacts/python/
// homeassistant_operator_client.py), both emitted from the committed
// operator-contract.json. Same gate, same drift idiom — a stale generated
// consumer layer reddens `contracts:check`.
const { generateWebuiFacade } = await import('./generate-webui-facade.ts');
const { generateHomeassistantClient } = await import('./generate-homeassistant-client.ts');
let consumerDrift = false;
consumerDrift = generateWebuiFacade({ check: true }) || consumerDrift;
consumerDrift = generateHomeassistantClient({ check: true }) || consumerDrift;
if (consumerDrift) {
  console.error('[contracts:check] generated consumer transport drift — run `bun run refresh:contracts`');
  process.exit(1);
}
