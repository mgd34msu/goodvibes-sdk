#!/usr/bin/env bun
/**
 * check-foundation-io-coverage.ts
 *
 * Typed-IO coverage RATCHET. Counts how many operator method ids lack full
 * typed IO (absent from OperatorMethodInputMap and/or OperatorMethodOutputMap
 * in packages/contracts/src/generated/foundation-client-types.ts, so they
 * resolve to the broad `unknown` fallback) and compares that count to the
 * frozen baseline in foundation-io-coverage-baseline.ts.
 *
 *   - count INCREASED -> fail: a new method shipped without typed IO. The
 *     newly-untyped ids are printed; add their InputMap/OutputMap entries (and
 *     an ENTRIES row in check-foundation-io-types.ts so they stay in sync).
 *   - count DECREASED -> fail: coverage improved; lower the baseline to lock it
 *     in (a stale, too-high baseline must not silently outlive the debt it
 *     recorded — same discipline as the line-cap grandfather ratchet).
 *   - unchanged -> pass.
 *
 * This is a companion to check-foundation-io-types.ts (which proves the
 * hand-authored entries do not DRIFT from their schemas). This script proves
 * the untyped SET does not GROW. Both run under `contracts:check`.
 *
 * Usage:
 *   bun run scripts/check-foundation-io-coverage.ts          # report + enforce
 *   bun run scripts/check-foundation-io-coverage.ts --check  # same (flag accepted for parity)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FOUNDATION_IO_COVERAGE_BASELINE } from './foundation-io-coverage-baseline.ts';
import {
  evaluateRatchet,
  parseMapKeys,
  parseMethodIds,
  untypedMethodIds,
} from './foundation-io-coverage-rule.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const FOUNDATION_TYPES_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/foundation-client-types.ts');
const METHOD_IDS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-method-ids.ts');

const foundationText = readFileSync(FOUNDATION_TYPES_PATH, 'utf8');
const idsText = readFileSync(METHOD_IDS_PATH, 'utf8');

const methodIds = parseMethodIds(idsText);
const inputKeys = parseMapKeys(foundationText, 'OperatorMethodInputMap');
const outputKeys = parseMapKeys(foundationText, 'OperatorMethodOutputMap');
const untyped = untypedMethodIds(methodIds, inputKeys, outputKeys);

const result = evaluateRatchet(untyped.length, FOUNDATION_IO_COVERAGE_BASELINE);

console.log(
  `[check-foundation-io-coverage] ${methodIds.length} operator methods, ` +
    `${methodIds.length - untyped.length} fully typed, ${untyped.length} untyped ` +
    `(baseline ${FOUNDATION_IO_COVERAGE_BASELINE}).`,
);

if (result.direction === 'increased') {
  console.error(
    `\n[check-foundation-io-coverage] FAIL: untyped operator-method count rose from ` +
      `${result.baseline} to ${result.current}. New methods must ship with typed IO ` +
      `entries in packages/contracts/src/generated/foundation-client-types.ts ` +
      `(OperatorMethodInputMap + OperatorMethodOutputMap) plus an ENTRIES row in ` +
      `scripts/check-foundation-io-types.ts.\n\nThe ${untyped.length} currently-untyped method ids:`,
  );
  for (const id of untyped) console.error(`  - ${id}`);
  process.exit(1);
}

if (result.direction === 'decreased') {
  console.error(
    `\n[check-foundation-io-coverage] FAIL (stale baseline): untyped count is now ` +
      `${result.current}, below the recorded baseline ${result.baseline}. Typed coverage ` +
      `improved — lower FOUNDATION_IO_COVERAGE_BASELINE in ` +
      `scripts/foundation-io-coverage-baseline.ts to ${result.current} to lock it in.`,
  );
  process.exit(1);
}

console.log('[check-foundation-io-coverage] PASS: untyped operator-method count has not grown.');
