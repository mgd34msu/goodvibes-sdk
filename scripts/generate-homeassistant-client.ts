#!/usr/bin/env bun
/**
 * generate-homeassistant-client.ts
 *
 * Emits the MECHANICAL Python transport layer for the Home Assistant integration
 * (custom_components/goodvibes/client.py + schemas.py hand-write this today), from
 * the committed operator contract. HA keeps its ergonomic layer — the aiohttp
 * `_request` core, SSE/multipart variants, the voluptuous service validators, the
 * webhook + conversation transports — hand-written on top.
 *
 * Scope is HONEST: HA consumes only a subset of the operator surface as plain
 * REST, so this generates for exactly that subset (inventoried from its client).
 * The daemon endpoints HA reaches that are NOT operator methods — the webhook
 * (/webhook/homeassistant), the conversation stream/cancel, and the surface
 * health probe — carry no contract entry and are intentionally excluded; they
 * stay hand-written. Full-surface generation is not the goal.
 *
 * Emits, for the consumed subset:
 *   - CONTRACT_VERSION: the daemon contract version these types were generated
 *     against (the version pin surface).
 *   - CONSUMED_METHOD_IDS: the operator method ids this client depends on (the
 *     capability surface — the daemon must expose these).
 *   - OPERATOR_ROUTES: methodId -> OperatorRoute(method, path) route constants.
 *   - Per-method input/output TypedDicts, generated from the contract's JSON
 *     Schemas (nested objects degrade to Mapping[str, Any], matching HA's
 *     existing dict-based transport rather than inventing deep structure).
 *
 * Deterministic (sorted ids, no clock): a regenerated file is byte-identical
 * unless the contract changed — the committed-artifact + --check drift idiom.
 *
 * Source of truth: packages/contracts/artifacts/operator-contract.json
 * Output (committed): packages/contracts/artifacts/python/homeassistant_operator_client.py
 *
 * Usage:
 *   bun scripts/generate-homeassistant-client.ts          # regenerate
 *   bun scripts/generate-homeassistant-client.ts --check  # exit 1 on drift
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonSchema, OperatorContractManifest, OperatorMethodContract } from '../packages/contracts/src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
export const HA_CLIENT_CONTRACT_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json');
export const HA_CLIENT_OUT_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/python/homeassistant_operator_client.py');

/**
 * The operator method ids the HA integration reaches as plain REST, inventoried
 * from custom_components/goodvibes/client.py. `homeassistant.*` (the whole
 * home-graph surface) plus a handful of shared verbs. Every id is asserted to
 * exist in the contract, so a renamed/removed method reddens the drift gate.
 */
export const CONSUMED_EXPLICIT_IDS: readonly string[] = [
  'control.status',
  'channels.tools.surface.list',
  'channels.agent_tools.surface.list',
  'channels.tools.invoke',
  'channels.actions.invoke',
  'tasks.get',
  'tasks.cancel',
  'tasks.status',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** methodId -> PascalCase identifier stem, e.g. homeassistant.homeGraph.map -> HomeassistantHomeGraphMap. */
function pascalStem(methodId: string): string {
  return methodId
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function literalOf(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value ? 'True' : value === false ? 'False' : String(value);
  if (value === null) return 'None';
  return 'Any';
}

/**
 * Map a JSON Schema node to a Python type expression. Nested objects degrade to
 * `Mapping[str, Any]` — HA's transport is dict-based today, so deep typing would
 * invent structure the integration does not carry. Top-level object schemas are
 * handled by the TypedDict emitter, not here.
 */
function pyType(schema: JsonSchema | undefined): string {
  const record = asRecord(schema);
  if (!record) return 'Any';

  const anyOf = record['anyOf'];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const branches: string[] = [];
    for (const branch of anyOf as JsonSchema[]) {
      const t = pyType(branch);
      // `Any` absorbs every other branch — a union with it is just `Any`.
      if (t === 'Any') return 'Any';
      if (!branches.includes(t)) branches.push(t);
    }
    return branches.length === 1 ? branches[0] : branches.join(' | ');
  }

  const enumValues = record['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return `Literal[${enumValues.map(literalOf).join(', ')}]`;
  }

  const type = record['type'];
  if (type === 'object' || (type === undefined && asRecord(record['properties']))) {
    return 'Mapping[str, Any]';
  }
  if (type === 'array') {
    const items = record['items'];
    if (items && !Array.isArray(items)) return `list[${pyType(items as JsonSchema)}]`;
    return 'list[Any]';
  }
  switch (type) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'None';
    default:
      return 'Any';
  }
}

/** Emit a TypedDict class for an object schema, or a plain alias when not an object. */
function emitTypedDict(name: string, schema: JsonSchema | undefined): string {
  const record = asRecord(schema);
  const properties = record ? asRecord(record['properties']) : null;
  const isObject = record ? record['type'] === 'object' || (record['type'] === undefined && properties) : false;

  if (!isObject || !properties || Object.keys(properties).length === 0) {
    // No declared shape (opaque object, absent schema, or non-object): a Mapping alias.
    const alias = record && !isObject ? pyType(schema) : 'Mapping[str, Any]';
    return `${name} = ${alias}`;
  }

  const required = new Set<string>(
    Array.isArray(record!['required']) ? (record!['required'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
  );
  const lines = [`class ${name}(TypedDict, total=True):`];
  for (const key of Object.keys(properties)) {
    const fieldType = pyType(properties[key] as JsonSchema);
    const annotated = required.has(key) ? fieldType : `NotRequired[${fieldType}]`;
    lines.push(`    ${pyFieldKey(key)}: ${annotated}`);
  }
  return lines.join('\n');
}

/** JSON keys are arbitrary; a non-identifier key can't be a TypedDict field name. */
function pyFieldKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

export function consumedIdsFor(contract: OperatorContractManifest): string[] {
  const byId = new Map(contract.operator.methods.map((m) => [m.id, m] as const));
  const ids = new Set<string>(CONSUMED_EXPLICIT_IDS);
  for (const method of contract.operator.methods) {
    if (method.id.startsWith('homeassistant.')) ids.add(method.id);
  }
  const missing = [...ids].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`[homeassistant-client] consumed method id(s) absent from contract: ${missing.join(', ')}`);
  }
  return [...ids].sort();
}

export function render(contract: OperatorContractManifest): string {
  const byId = new Map(contract.operator.methods.map((m) => [m.id, m] as const));
  const sortedIds = consumedIdsFor(contract);

  const routeLines = sortedIds.map((id) => {
    const http = (byId.get(id) as OperatorMethodContract).http!;
    return `    ${JSON.stringify(id)}: OperatorRoute(${JSON.stringify(http.method)}, ${JSON.stringify(http.path)}),`;
  });

  const typedDictBlocks: string[] = [];
  for (const id of sortedIds) {
    const method = byId.get(id) as OperatorMethodContract;
    const stem = pascalStem(id);
    typedDictBlocks.push(`# ${id}`);
    typedDictBlocks.push(emitTypedDict(`${stem}Input`, method.inputSchema));
    typedDictBlocks.push('');
    typedDictBlocks.push(emitTypedDict(`${stem}Output`, method.outputSchema));
    typedDictBlocks.push('');
  }

  const consumedTuple = sortedIds.map((id) => `    ${JSON.stringify(id)},`);

  return [
    '"""GENERATED — do not edit. Regenerate with `bun run refresh:contracts`.',
    '',
    'Mechanical transport layer for the GoodVibes Home Assistant integration,',
    'emitted from the operator contract by scripts/generate-homeassistant-client.ts.',
    'Covers only the REST subset HA consumes; the webhook, conversation stream,',
    'and surface health probe are not operator methods and stay hand-written.',
    '',
    `Contract product version: ${contract.product.version}`,
    `Consumed operator methods: ${sortedIds.length}`,
    '"""',
    'from __future__ import annotations',
    '',
    'from typing import Any, Literal, Mapping, NamedTuple, NotRequired, TypedDict',
    '',
    '#: Daemon contract version these types were generated against (the version pin).',
    `CONTRACT_VERSION: str = ${JSON.stringify(contract.product.version)}`,
    '',
    '',
    'class OperatorRoute(NamedTuple):',
    '    """An operator method\'s REST binding: HTTP verb and path template."""',
    '',
    '    method: str',
    '    path: str',
    '',
    '',
    '#: The operator method ids this client depends on (the capability surface).',
    'CONSUMED_METHOD_IDS: frozenset[str] = frozenset({',
    ...consumedTuple,
    '})',
    '',
    '#: methodId -> REST route constants for every consumed method.',
    'OPERATOR_ROUTES: dict[str, OperatorRoute] = {',
    ...routeLines,
    '}',
    '',
    '',
    ...typedDictBlocks,
  ].join('\n');
}

/** Load the committed operator contract artifact. */
export function loadContract(): OperatorContractManifest {
  return JSON.parse(readFileSync(HA_CLIENT_CONTRACT_PATH, 'utf8')) as OperatorContractManifest;
}

/**
 * Regenerate (or, in check mode, drift-check) the committed HA Python client.
 * Returns true when the on-disk artifact differs from a fresh generation.
 */
export function generateHomeassistantClient({ check }: { check: boolean }): boolean {
  const contract = loadContract();
  const output = render(contract);
  const content = output.endsWith('\n') ? output : `${output}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(HA_CLIENT_OUT_PATH, 'utf8');
  } catch {
    current = null;
  }
  if (current === content) {
    console.log(check ? '[homeassistant-client] artifact up-to-date' : `[homeassistant-client] ${consumedIdsFor(contract).length} consumed methods emitted`);
    return false;
  }
  if (check) {
    console.error(`[homeassistant-client] drift: ${HA_CLIENT_OUT_PATH}`);
    return true;
  }
  mkdirSync(dirname(HA_CLIENT_OUT_PATH), { recursive: true });
  writeFileSync(HA_CLIENT_OUT_PATH, content, 'utf8');
  console.log(`[homeassistant-client] wrote ${HA_CLIENT_OUT_PATH} — ${consumedIdsFor(contract).length} consumed methods`);
  return false;
}

if (import.meta.main) {
  const drifted = generateHomeassistantClient({ check: process.argv.includes('--check') });
  if (drifted) {
    console.error('[homeassistant-client] drift detected — run `bun run refresh:contracts`');
    process.exit(1);
  }
}
