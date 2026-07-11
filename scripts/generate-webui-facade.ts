#!/usr/bin/env bun
/**
 * generate-webui-facade.ts
 *
 * Emits the MECHANICAL transport layer the webui currently hand-writes in
 * src/lib/goodvibes.ts (the EXTRA_METHOD_ROUTES table, the ws-only generic-invoke
 * set) and src/lib/goodvibes.test.ts (per-method bridge samples), so the webui
 * can adopt a generated, drift-checked layer and keep only its ergonomic
 * wrappers (interpolateRoute, invokeOperator, per-family types) hand-written.
 *
 * The generated module carries, straight from the committed operator contract:
 *   - WEBUI_METHOD_ROUTES:   methodId -> { method, path } for every method that
 *     advertises a plain-REST http binding (the REST disposition).
 *   - WEBUI_WS_INVOKE_METHOD_IDS: methods reachable ONLY through the generic
 *     gateway-method invoke endpoint (transport ['ws'], no http binding).
 *   - WEBUI_METHOD_DISPOSITION: methodId -> 'rest' | 'ws-invoke' for all methods.
 *   - WEBUI_METHOD_SAMPLES:  schema-valid input/output sample per method, reusing
 *     the Stage-B fixture generator (sampleFromSchema) so a bridge sample is
 *     generated rather than hand-authored.
 *   - Re-exported typed IO generics (OperatorMethodInput/Output) so a consumer's
 *     generated facade is self-contained.
 *
 * Deterministic (catalog order, no clock, no randomness): a regenerated artifact
 * is byte-identical unless the contract changed — the property that lets the
 * committed artifact carry a --check drift gate wired into `contracts:check`.
 *
 * Source of truth: packages/contracts/artifacts/operator-contract.json
 * Output (committed, package-exported): packages/contracts/src/generated/webui-facade.ts
 *
 * Usage:
 *   bun scripts/generate-webui-facade.ts          # regenerate
 *   bun scripts/generate-webui-facade.ts --check  # exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sampleFromSchema } from '../packages/contracts/src/testing/mock-daemon.ts';
import type { OperatorContractManifest, OperatorMethodContract } from '../packages/contracts/src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

export const WEBUI_FACADE_CONTRACT_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json');
export const WEBUI_FACADE_OUT_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/webui-facade.ts');

/** JSON.stringify with stable 2-space indent for a plain (already-cloned) value. */
function stable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface RouteRow {
  readonly method: string;
  readonly path: string;
}

export function buildRoutes(methods: readonly OperatorMethodContract[]): Record<string, RouteRow> {
  const routes: Record<string, RouteRow> = {};
  for (const method of methods) {
    if (method.http) {
      routes[method.id] = { method: method.http.method, path: method.http.path };
    }
  }
  return routes;
}

export function buildWsInvokeIds(methods: readonly OperatorMethodContract[]): string[] {
  return methods
    .filter((method) => !method.http && method.transport.includes('ws'))
    .map((method) => method.id);
}

export function buildDisposition(methods: readonly OperatorMethodContract[]): Record<string, string> {
  const disposition: Record<string, string> = {};
  for (const method of methods) {
    disposition[method.id] = method.http ? 'rest' : 'ws-invoke';
  }
  return disposition;
}

export function buildSamples(methods: readonly OperatorMethodContract[]): Record<string, { input: unknown; output: unknown }> {
  const samples: Record<string, { input: unknown; output: unknown }> = {};
  for (const method of methods) {
    samples[method.id] = {
      input: sampleFromSchema(method.inputSchema),
      output: sampleFromSchema(method.outputSchema),
    };
  }
  return samples;
}

export function render(contract: OperatorContractManifest): string {
  const methods = contract.operator.methods;
  const routes = buildRoutes(methods);
  const wsInvokeIds = buildWsInvokeIds(methods);
  const disposition = buildDisposition(methods);
  const samples = buildSamples(methods);
  const restCount = Object.keys(routes).length;

  return [
    `import type { OperatorMethodInput, OperatorMethodOutput } from './foundation-client-types.js';`,
    `import type { OperatorMethodId } from './operator-method-ids.js';`,
    ``,
    `/**`,
    ` * GENERATED — do not edit. Regenerate with \`bun run refresh:contracts\`.`,
    ` *`,
    ` * The mechanical transport layer for the webui facade (src/lib/goodvibes.ts),`,
    ` * emitted from the operator contract by scripts/generate-webui-facade.ts. The`,
    ` * webui keeps its ergonomic wrappers (route interpolation, per-family typed`,
    ` * call sites) hand-written on top of these generated primitives.`,
    ` *`,
    ` * Contract product version: ${contract.product.version}`,
    ` * Methods: ${methods.length} total, ${restCount} REST-routed, ${wsInvokeIds.length} ws-only invoke.`,
    ` */`,
    ``,
    `export type WebuiHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';`,
    ``,
    `export interface WebuiRouteDefinition {`,
    `  readonly method: WebuiHttpMethod;`,
    `  /** May contain {param} placeholders folded in from the method input. */`,
    `  readonly path: string;`,
    `}`,
    ``,
    `/** How a method is reached over the wire. */`,
    `export type WebuiMethodDisposition = 'rest' | 'ws-invoke';`,
    ``,
    `/** One generated bridge sample: schema-valid input and output for a method. */`,
    `export interface WebuiMethodSample {`,
    `  readonly input: unknown;`,
    `  readonly output: unknown;`,
    `}`,
    ``,
    `/**`,
    ` * Every operator method that advertises a plain-REST http binding, keyed by`,
    ` * method id. The webui derives its EXTRA_METHOD_ROUTES from this by removing`,
    ` * the ids its pinned browser SDK route maps already cover.`,
    ` */`,
    `export const WEBUI_METHOD_ROUTES: Readonly<Record<string, WebuiRouteDefinition>> = ${stable(routes)} as const;`,
    ``,
    `/**`,
    ` * Methods reachable ONLY through the generic gateway-method invoke endpoint`,
    ` * (transport ['ws'], no http binding) — the webui posts these to`,
    ` * /api/control-plane/methods/{methodId}/invoke.`,
    ` */`,
    `export const WEBUI_WS_INVOKE_METHOD_IDS: readonly string[] = ${stable(wsInvokeIds)} as const;`,
    ``,
    `/** methodId -> disposition for every cataloged method. */`,
    `export const WEBUI_METHOD_DISPOSITION: Readonly<Record<string, WebuiMethodDisposition>> = ${stable(disposition)} as const;`,
    ``,
    `/**`,
    ` * Schema-valid input/output sample per method, generated from the contract's`,
    ` * own JSON Schemas (the Stage-B fixture generator). Consumers cross-check`,
    ` * their bridge types against these instead of hand-authoring fixtures.`,
    ` */`,
    `export const WEBUI_METHOD_SAMPLES: Readonly<Record<string, WebuiMethodSample>> = ${stable(samples)} as const;`,
    ``,
    `/** Typed input for a method id, straight from the contract's IO ratchet. */`,
    `export type WebuiMethodInput<TMethodId extends OperatorMethodId> = OperatorMethodInput<TMethodId>;`,
    `/** Typed output for a method id, straight from the contract's IO ratchet. */`,
    `export type WebuiMethodOutput<TMethodId extends OperatorMethodId> = OperatorMethodOutput<TMethodId>;`,
    ``,
  ].join('\n');
}

/** Load the committed operator contract artifact. */
export function loadContract(): OperatorContractManifest {
  return JSON.parse(readFileSync(WEBUI_FACADE_CONTRACT_PATH, 'utf8')) as OperatorContractManifest;
}

/**
 * Regenerate (or, in check mode, drift-check) the committed webui-facade.ts.
 * Returns true when the on-disk artifact differs from a fresh generation.
 */
export function generateWebuiFacade({ check }: { check: boolean }): boolean {
  const contract = loadContract();
  const content = render(contract);
  let current: string | null = null;
  try {
    current = readFileSync(WEBUI_FACADE_OUT_PATH, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) {
    if (!check) {
      const routes = Object.keys(buildRoutes(contract.operator.methods)).length;
      const ws = buildWsInvokeIds(contract.operator.methods).length;
      console.log(`[webui-facade] ${contract.operator.methods.length} methods, ${routes} REST-routed, ${ws} ws-only invoke`);
    } else {
      console.log('[webui-facade] artifact up-to-date');
    }
    return false;
  }
  if (check) {
    console.error(`[webui-facade] drift: ${WEBUI_FACADE_OUT_PATH}`);
    return true;
  }
  writeFileSync(WEBUI_FACADE_OUT_PATH, content, 'utf8');
  const routes = Object.keys(buildRoutes(contract.operator.methods)).length;
  const ws = buildWsInvokeIds(contract.operator.methods).length;
  console.log(`[webui-facade] wrote ${WEBUI_FACADE_OUT_PATH} — ${contract.operator.methods.length} methods, ${routes} REST-routed, ${ws} ws-only invoke`);
  return false;
}

if (import.meta.main) {
  const drifted = generateWebuiFacade({ check: process.argv.includes('--check') });
  if (drifted) {
    console.error('[webui-facade] drift detected — run `bun run refresh:contracts`');
    process.exit(1);
  }
}
