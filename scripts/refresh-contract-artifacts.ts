#!/usr/bin/env bun
/**
 * refresh-contract-artifacts.ts
 *
 * Regenerates the checked-in contract artifacts from live source of truth:
 *
 *   - packages/contracts/artifacts/operator-contract.json
 *   - packages/contracts/artifacts/peer-contract.json
 *   - packages/contracts/src/generated/operator-contract.ts
 *   - packages/contracts/src/generated/operator-method-ids.ts
 *   - packages/contracts/src/generated/peer-contract.ts
 *   - packages/contracts/src/generated/peer-endpoint-ids.ts
 *
 * Source of truth:
 *   - Operator: buildOperatorContract(new GatewayMethodCatalog()) — built-in methods/events
 *     auto-registered from the method-catalog-* modules, product.version overridden with
 *     the SDK's current VERSION.
 *   - Peer: the authoritative PEER_CONTRACT constant exported from the contracts package
 *     (peer contract is hand-maintained; this script just re-emits the JSON artifact from it).
 *
 * Usage:
 *   bun run scripts/refresh-contract-artifacts.ts
 *   bun run scripts/refresh-contract-artifacts.ts --check   # exit 1 if any artifact drifted
 *
 * After a successful refresh, run `bun run docs:generate` to refresh
 * docs/reference-*.md from the new artifacts, then `bun run sync:internal`
 * to propagate the contracts package into _internal/contracts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayMethodCatalog } from '../packages/sdk/src/_internal/platform/control-plane/method-catalog.ts';
import { buildOperatorContract } from '../packages/sdk/src/_internal/platform/control-plane/operator-contract.ts';
import { PEER_CONTRACT } from '../packages/contracts/src/generated/peer-contract.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const OPERATOR_JSON_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json');
const PEER_JSON_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/peer-contract.json');
const OPERATOR_TS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-contract.ts');
const OPERATOR_METHOD_IDS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-method-ids.ts');
const PEER_TS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/peer-contract.ts');
const PEER_ENDPOINT_IDS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/peer-endpoint-ids.ts');

/**
 * Stringify that preserves shared DAG references (duplicates them in the
 * output) but flags true cycles. Tracks ancestors on the current descent path
 * via a Set; removes entries on return so siblings don't collide.
 */
function safeStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const clone = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as object;
    // Self-referencing JSON Schema (common pattern for 'any JSON value' types).
    // Replace with empty schema {} which is JSON Schema's idiomatic 'accept anything'.
    if (ancestors.has(obj)) return {};
    ancestors.add(obj);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map((item) => clone(item));
    } else {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) result[k] = clone(val);
      out = result;
    }
    ancestors.delete(obj);
    return out;
  };
  return JSON.stringify(clone(value), null, 2);
}

function writeIfChanged(path: string, content: string): boolean {
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) return false;
  if (CHECK_ONLY) {
    console.error(`[refresh:contracts] drift: ${path}`);
    return true;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`[refresh:contracts] wrote: ${path}`);
  return true;
}

function renderOperatorContractTs(contract: unknown): string {
  const json = safeStringify(contract);
  return [
    `import type { OperatorContractManifest } from '../types.js';`,
    ``,
    `export const OPERATOR_CONTRACT: OperatorContractManifest = ${json} as const;`,
    ``,
  ].join('\n');
}

function renderPeerContractTs(contract: unknown): string {
  const json = safeStringify(contract);
  return [
    `import type { PeerContractManifest } from '../types.js';`,
    ``,
    `export const PEER_CONTRACT: PeerContractManifest = ${json} as const;`,
    ``,
  ].join('\n');
}

function renderMethodIdsTs(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const quoted = sorted.map((id) => `  "${id}",`).join('\n');
  return [
    `export const OPERATOR_METHOD_IDS = [`,
    quoted,
    `] as const;`,
    `export type OperatorMethodId = typeof OPERATOR_METHOD_IDS[number];`,
    ``,
  ].join('\n');
}

function renderEndpointIdsTs(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  const quoted = sorted.map((id) => `  "${id}",`).join('\n');
  return [
    `export const PEER_ENDPOINT_IDS = [`,
    quoted,
    `] as const;`,
    `export type PeerEndpointId = typeof PEER_ENDPOINT_IDS[number];`,
    ``,
  ].join('\n');
}

const catalog = new GatewayMethodCatalog();
const operatorContract = buildOperatorContract(catalog);
const operatorMethodIds = operatorContract.operator.methods.map((m) => m.id);
const peerEndpointIds = PEER_CONTRACT.endpoints.map((e) => e.id);

const operatorJson = safeStringify(operatorContract) + '\n';
const peerJson = safeStringify(PEER_CONTRACT) + '\n';

let drifted = false;
drifted = writeIfChanged(OPERATOR_JSON_PATH, operatorJson) || drifted;
drifted = writeIfChanged(PEER_JSON_PATH, peerJson) || drifted;
drifted = writeIfChanged(OPERATOR_TS_PATH, renderOperatorContractTs(operatorContract)) || drifted;
drifted = writeIfChanged(OPERATOR_METHOD_IDS_PATH, renderMethodIdsTs(operatorMethodIds)) || drifted;
drifted = writeIfChanged(PEER_TS_PATH, renderPeerContractTs(PEER_CONTRACT)) || drifted;
drifted = writeIfChanged(PEER_ENDPOINT_IDS_PATH, renderEndpointIdsTs(peerEndpointIds)) || drifted;

console.log(`[refresh:contracts] product version: ${operatorContract.product.version}`);
console.log(`[refresh:contracts] operator methods: ${operatorMethodIds.length}`);
console.log(`[refresh:contracts] operator events:  ${operatorContract.operator.events.length}`);
console.log(`[refresh:contracts] peer endpoints:   ${peerEndpointIds.length}`);

if (CHECK_ONLY && drifted) {
  console.error('[refresh:contracts] drift detected \u2014 run `bun run refresh:contracts`');
  process.exit(1);
}

if (!drifted) {
  console.log('[refresh:contracts] artifacts up-to-date');
}
