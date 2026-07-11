#!/usr/bin/env bun
/**
 * release-artifact-lane.ts — the packaged-artifact coherence gate.
 *
 * The manual release-train validation, formalized: pack every workspace package
 * exactly as publish would (`npm pack` over the normalized publish manifests),
 * install the packed tarballs into a scratch consumer project, and run the
 * SHIPPED conformance kit (@pellux/goodvibes-contracts/testing) against a
 * catalog/daemon composed FROM THE PACKED ARTIFACTS — never from the workspace
 * source. It proves the tarballs are internally coherent before they are
 * published; consumer repos run their own suites against the pins at release
 * time, and this lane is the SDK half of that standing consumer-matrix gate.
 *
 * Per-check honesty: the in-scratch conformance script prints one PASS/FAIL line
 * per check and exits non-zero if any fails, so a partial failure is never
 * rolled up into a green pass.
 *
 * Checks (all run against the installed tarballs' public API):
 *   - packed catalog vs packed contract parity: the operator contract rebuilt
 *     from the packed SDK's GatewayMethodCatalog matches the packed
 *     @pellux/goodvibes-contracts artifact (method ids + REST bindings).
 *   - descriptors-have-handlers: the shipped conformance kit run against a
 *     catalog with the packed terminal-shell ws-only handlers attached — the
 *     ws-only verb family goes from handler-less (501) to invokable.
 *   - catalog invoke round-trips: every cataloged method answers a schema-valid
 *     200 through the shipped mock-daemon fixture generator.
 *   - REST parity: every REST-bound method resolves by HTTP method+path to the
 *     same method id it answers by invoke.
 *
 * Usage:
 *   bun run release:artifact-lane          # pack + install + conformance
 */

import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanupStage,
  collectTarballs,
  createSdkTempDir,
  packStage,
  run,
  stagePackages,
} from './release-shared.ts';

/**
 * The conformance script run INSIDE the scratch consumer, against the installed
 * tarballs only. Prints one PASS/FAIL line per check; exits 1 if any fails.
 */
const CONFORMANCE_SCRIPT = `
import { OPERATOR_CONTRACT, OPERATOR_METHOD_IDS } from '@pellux/goodvibes-contracts';
import {
  createMockDaemon,
  buildMockDaemonResponses,
  findMethodsMissingHandlers,
  assertEveryDescriptorHasHandler,
} from '@pellux/goodvibes-contracts/testing';
import { GatewayMethodCatalog, buildOperatorContract } from '@pellux/goodvibes-sdk/platform/control-plane';
import { attachWsOnlyGatewayVerbHandlers } from '@pellux/goodvibes-terminal-shell';

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL ' + name + ' — ' + (err && err.message ? err.message : String(err)));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Stub deps: registration only wires handlers onto descriptors; no handler runs here.
const verbGroupDeps = {
  processRegistry: { query: () => ({ nodes: [], generatedAt: 0 }) },
  workspaceCheckpointManager: {},
  sessionBroker: {},
  secretsManager: { get: async () => null, set: async () => {} },
  approvalBroker: { subscribe: () => () => {} },
  shellPaths: { resolveUserPath: (...segments) => '/nonexistent-artifact-lane/' + segments.join('/') },
};

check('packed-catalog-vs-contract-parity', () => {
  const rebuilt = buildOperatorContract(new GatewayMethodCatalog());
  const rebuiltIds = rebuilt.operator.methods.map((m) => m.id).sort();
  const contractIds = [...OPERATOR_METHOD_IDS].sort();
  assert(
    rebuiltIds.length === contractIds.length && rebuiltIds.every((id, i) => id === contractIds[i]),
    'packed SDK catalog method ids differ from packed contract OPERATOR_METHOD_IDS',
  );
  const contractById = new Map(OPERATOR_CONTRACT.operator.methods.map((m) => [m.id, m]));
  for (const method of rebuilt.operator.methods) {
    const contractMethod = contractById.get(method.id);
    assert(contractMethod, 'packed contract missing method ' + method.id);
    const a = method.http ? method.http.method + ' ' + method.http.path : null;
    const b = contractMethod.http ? contractMethod.http.method + ' ' + contractMethod.http.path : null;
    assert(a === b, 'REST binding mismatch for ' + method.id + ': packed-sdk=' + a + ' packed-contract=' + b);
  }
});

check('descriptors-have-handlers', () => {
  const before = new GatewayMethodCatalog();
  const missingBefore = new Set(findMethodsMissingHandlers(before));
  const after = new GatewayMethodCatalog();
  attachWsOnlyGatewayVerbHandlers(after, verbGroupDeps);
  const missingAfter = new Set(findMethodsMissingHandlers(after));
  const nowHandled = [...missingBefore].filter((id) => !missingAfter.has(id));
  // The packed terminal-shell attaches handlers onto the ws-only verb family —
  // the exact 501 regression class the shipped conformance kit exists to catch.
  const representatives = ['fleet.snapshot', 'fleet.list', 'fleet.archived.list', 'sessions.search'];
  for (const id of representatives) {
    assert(missingBefore.has(id), 'expected ' + id + ' handler-less on a bare packed catalog');
    assert(nowHandled.includes(id), 'packed terminal-shell did not attach a handler for ' + id);
  }
  assertEveryDescriptorHasHandler(after, { onlyIds: representatives });
  // And the bare catalog still fails the same scoped gate — the gate has teeth.
  let threw = false;
  try { assertEveryDescriptorHasHandler(before, { onlyIds: representatives }); } catch { threw = true; }
  assert(threw, 'conformance gate did not fail on the handler-less bare catalog');
});

check('catalog-invoke-round-trips', () => {
  const daemon = createMockDaemon(OPERATOR_CONTRACT);
  const responses = buildMockDaemonResponses(OPERATOR_CONTRACT);
  assert(responses.length === OPERATOR_CONTRACT.operator.methods.length, 'response count != method count');
  for (const id of OPERATOR_METHOD_IDS) {
    const answer = daemon.answer(id);
    assert(answer, 'no invoke round-trip for ' + id);
    assert(answer.status === 200, 'method ' + id + ' did not answer 200');
    assert(answer.methodId === id, 'invoke round-trip method id mismatch for ' + id);
  }
});

check('rest-parity', () => {
  const daemon = createMockDaemon(OPERATOR_CONTRACT);
  let restCount = 0;
  for (const method of OPERATOR_CONTRACT.operator.methods) {
    if (!method.http) continue;
    restCount += 1;
    const byHttp = daemon.answerHttp(method.http.method, method.http.path);
    assert(byHttp, 'no REST route resolves ' + method.http.method + ' ' + method.http.path);
    assert(byHttp.methodId === method.id, 'REST route ' + method.http.path + ' resolves to ' + byHttp.methodId + ', not ' + method.id);
  }
  assert(restCount > 0, 'no REST-bound methods found — packed contract looks empty');
  console.log('  (' + restCount + ' REST-bound methods checked)');
});

if (failures.length > 0) {
  console.log('artifact-lane conformance FAILED: ' + failures.join(', '));
  process.exit(1);
}
console.log('artifact-lane conformance ok');
`;

function writeConsumerFiles(projectDir: string): void {
  writeFileSync(
    resolve(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'goodvibes-sdk-artifact-lane', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(resolve(projectDir, 'conformance.mjs'), `${CONFORMANCE_SCRIPT.trim()}\n`);
}

// Transient network errors on CI install are retried; code-level failures are not.
async function retryOnNetworkError(op: () => void, label: string): Promise<void> {
  const BACKOFF_MS = [0, 2000, 5000];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        const delay = BACKOFF_MS[attempt - 1] ?? 5000;
        console.log(`[artifact-lane] ${label}: attempt ${attempt}/3 after ${delay}ms backoff`);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
      op();
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|aborted/i.test(msg) || attempt === 3) throw err;
      console.log(`[artifact-lane] ${label}: transient network error, retrying (${msg.slice(0, 160)})`);
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  console.log('[artifact-lane] packing workspace packages exactly as publish would...');
  const { tempRoot, publicStages } = await stagePackages();
  const packDestination = createSdkTempDir('goodvibes-sdk-artifact-lane-tarballs-');
  const projectDir = createSdkTempDir('goodvibes-sdk-artifact-lane-consumer-');
  try {
    const packResults = publicStages.map((stage) => packStage(stage.stageDir, packDestination));
    const tarballs = collectTarballs(packResults, packDestination);
    console.log(`[artifact-lane] packed ${tarballs.length} tarballs`);

    writeConsumerFiles(projectDir);
    // Pin zod@^4 explicitly so the dist's `zod/v4` subpath import resolves.
    await retryOnNetworkError(
      () => run('npm', ['install', ...tarballs, 'zod@^4'], projectDir, { stdio: 'inherit' }),
      'npm install',
    );

    console.log('[artifact-lane] running shipped conformance kit against the packed artifacts...');
    run('node', ['conformance.mjs'], projectDir, { stdio: 'inherit' });
    console.log('[artifact-lane] artifact lane passed — packed artifacts are internally coherent');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(packDestination, { recursive: true, force: true });
    cleanupStage(tempRoot);
  }
}

await main();
