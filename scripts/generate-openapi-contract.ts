#!/usr/bin/env bun
/**
 * generate-openapi-contract.ts
 *
 * Generates the published OpenAPI 3.1 document for the operator contract from
 * the committed contract artifact (the generated-artifact idiom: deterministic
 * output, committed, with a --check drift mode wired into `contracts:check`).
 *
 * Source of truth:
 *   - packages/contracts/artifacts/operator-contract.json  (methods, IO schemas,
 *     REST bindings, auth scheme, transports)
 *   - packages/contracts/src/generated/foundation-client-types.ts +
 *     operator-method-ids.ts (the typed-client-IO ratchet inputs) — used to mark
 *     the untyped methods HONESTLY: every method whose SDK client IO resolves to
 *     `unknown` carries `x-typed-client-io: false`. They are never omitted.
 *
 * Outputs (both committed, kept in lockstep by this one generator):
 *   - packages/contracts/artifacts/operator-openapi.json  (package-exported —
 *     prepare-sdk-package copies the artifacts dir into the SDK dist)
 *   - docs/operator-openapi.json                          (docs-fetchable copy)
 *
 * Usage:
 *   bun scripts/generate-openapi-contract.ts          # regenerate
 *   bun scripts/generate-openapi-contract.ts --check  # exit 1 on drift
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMapKeys, parseMethodIds, untypedMethodIds } from './foundation-io-coverage-rule.ts';
import type { OperatorContractManifest, OperatorMethodContract, JsonSchema } from '../packages/contracts/src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const CONTRACT_PATH = resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-contract.json');
const FOUNDATION_TYPES_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/foundation-client-types.ts');
const METHOD_IDS_PATH = resolve(SDK_ROOT, 'packages/contracts/src/generated/operator-method-ids.ts');
const ARTIFACT_OUT = resolve(SDK_ROOT, 'packages/contracts/artifacts/operator-openapi.json');
const DOCS_OUT = resolve(SDK_ROOT, 'docs/operator-openapi.json');

const INVOKE_PATH = '/api/control/gateway-methods/{methodId}/invoke';

interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security?: Record<string, string[]>[];
  parameters?: Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

function loadUntypedSet(): Set<string> {
  const foundationText = readFileSync(FOUNDATION_TYPES_PATH, 'utf8');
  const idsText = readFileSync(METHOD_IDS_PATH, 'utf8');
  const methodIds = parseMethodIds(idsText);
  const inputKeys = parseMapKeys(foundationText, 'OperatorMethodInputMap');
  const outputKeys = parseMapKeys(foundationText, 'OperatorMethodOutputMap');
  return new Set(untypedMethodIds(methodIds, inputKeys, outputKeys));
}

/** True when a schema is absent or a bare object with no declared properties. */
function isOpaqueSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return true;
  if (Object.keys(schema).length === 0) return true;
  return schema.type === 'object' && !Object.hasOwn(schema, 'properties');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]!);
}

function securityFor(method: OperatorMethodContract): Record<string, string[]>[] | undefined {
  // 'public' methods opt out of the document-level security requirement.
  if (method.access === 'public') return [];
  return undefined;
}

function buildParameters(method: OperatorMethodContract): Record<string, unknown>[] {
  const http = method.http!;
  const params: Record<string, unknown>[] = [];
  const pathParams = pathParamNames(http.path);
  for (const name of pathParams) {
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  // For GET/DELETE, top-level input properties travel as query parameters
  // (the gateway folds path params into the same invocation-params view).
  if ((http.method === 'GET' || http.method === 'DELETE') && !isOpaqueSchema(method.inputSchema)) {
    const properties = (method.inputSchema!.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((method.inputSchema!.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(properties)) {
      if (pathParams.includes(name)) continue;
      params.push({ name, in: 'query', required: required.has(name), schema });
    }
  }
  return params;
}

function buildOperation(method: OperatorMethodContract, untyped: Set<string>): OpenApiOperation {
  const http = method.http!;
  const isUntyped = untyped.has(method.id);
  const opaqueIn = isOpaqueSchema(method.inputSchema);
  const opaqueOut = isOpaqueSchema(method.outputSchema);
  const notes: string[] = [method.description];
  if (isUntyped) {
    notes.push(
      'NOTE: this method has no typed SDK client IO — request/response resolve to `unknown` in the typed client (see `x-typed-client-io`).',
    );
  }
  const op: OpenApiOperation = {
    operationId: method.id,
    summary: method.title,
    description: notes.join('\n\n'),
    tags: [method.category],
    responses: {
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: opaqueOut
              ? { description: 'Schema-less response (no declared output schema).', 'x-schema-coverage': 'schema-less' }
              : method.outputSchema,
          },
        },
      },
      default: { $ref: '#/components/responses/Error' },
    },
    'x-typed-client-io': !isUntyped,
    'x-access': method.access,
    'x-transport': method.transport,
    ...(method.scopes.length > 0 ? { 'x-scopes': method.scopes } : {}),
    ...(method.dangerous !== undefined ? { 'x-dangerous': method.dangerous } : {}),
    ...(method.idempotent !== undefined ? { 'x-idempotent': method.idempotent } : {}),
  };
  const security = securityFor(method);
  if (security) op.security = security;
  const parameters = buildParameters(method);
  if (parameters.length > 0) op.parameters = parameters;
  if (http.method === 'POST' || http.method === 'PATCH') {
    op.requestBody = {
      required: !opaqueIn,
      content: {
        'application/json': {
          schema: opaqueIn
            ? { description: 'Schema-less request (no declared input schema).', 'x-schema-coverage': 'schema-less' }
            : method.inputSchema,
        },
      },
    };
  }
  return op;
}

function buildInvokeOperation(invokeOnly: readonly OperatorMethodContract[]): OpenApiOperation {
  return {
    operationId: 'gateway.invoke',
    summary: 'Invoke a cataloged operator method by id',
    description:
      'The generic invoke endpoint. Every invokable cataloged method is reachable here by ' +
      'its method id; methods WITHOUT a dedicated REST binding (listed in `x-invoke-only-methods`) ' +
      'are reachable ONLY here. Per-method request/response schemas are the same as the ' +
      'per-method entries in `x-operator-methods`.',
    tags: ['gateway'],
    parameters: [{ name: 'methodId', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { type: 'object', description: 'The method-specific input (see the method’s inputSchema).' },
        },
      },
    },
    responses: {
      '200': {
        description: 'Method-specific response (see the method’s outputSchema).',
        content: { 'application/json': { schema: {} } },
      },
      default: { $ref: '#/components/responses/Error' },
    },
    'x-invoke-only-methods': invokeOnly.map((m) => m.id).sort(),
  };
}

function buildDocument(contract: OperatorContractManifest, untyped: Set<string>): Record<string, unknown> {
  const methods = contract.operator.methods;
  const withHttp = methods.filter((m) => m.http);
  const invokeOnly = methods.filter((m) => !m.http);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const method of withHttp) {
    const { path, method: verb } = method.http!;
    paths[path] ??= {};
    paths[path]![verb.toLowerCase()] = buildOperation(method, untyped);
  }
  paths[INVOKE_PATH] = { post: buildInvokeOperation(invokeOnly) };

  // Every method — REST-bound or invoke-only — appears in this index with its
  // honest coverage marking; the 97 untyped ids are visible, not omitted.
  const methodIndex = methods.map((m) => ({
    id: m.id,
    category: m.category,
    access: m.access,
    rest: m.http ? `${m.http.method} ${m.http.path}` : null,
    typedClientIo: !untyped.has(m.id),
    inputSchemaCoverage: isOpaqueSchema(m.inputSchema) ? 'schema-less' : 'typed',
    outputSchemaCoverage: isOpaqueSchema(m.outputSchema) ? 'schema-less' : 'typed',
  }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'GoodVibes Operator API',
      version: contract.product.version,
      description:
        'Generated from the operator contract (packages/contracts/artifacts/operator-contract.json). ' +
        `${methods.length} cataloged methods: ${withHttp.length} with dedicated REST bindings, ` +
        `${invokeOnly.length} reachable only through the generic invoke endpoint. ` +
        `${untyped.size} methods lack typed SDK client IO and are marked with ` +
        '`x-typed-client-io: false` — they are represented honestly, never omitted. ' +
        'Regenerate with `bun run openapi:generate`; drift fails `contracts:check`.',
    },
    servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '4483' } }, description: 'Local daemon' }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Operator bearer token (Authorization: Bearer <token>).',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: contract.auth.sessionCookie.name,
          description: 'Login-issued session cookie (see the contract auth.login route).',
        },
      },
      responses: {
        Error: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            kind: { type: 'string' },
            details: { type: 'object' },
          },
          required: ['error'],
        },
      },
    },
    'x-auth-contract': contract.auth,
    'x-untyped-client-io-count': untyped.size,
    'x-operator-methods': methodIndex,
  };
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
    console.error(`[openapi] drift: ${path}`);
    return true;
  }
  writeFileSync(path, content, 'utf8');
  console.log(`[openapi] wrote: ${path}`);
  return true;
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OperatorContractManifest;
const untyped = loadUntypedSet();
const document = buildDocument(contract, untyped);
const json = `${JSON.stringify(document, null, 2)}\n`;

let drifted = false;
drifted = writeIfChanged(ARTIFACT_OUT, json) || drifted;
drifted = writeIfChanged(DOCS_OUT, json) || drifted;

if (CHECK_ONLY && drifted) {
  console.error('[openapi] drift detected — run `bun run openapi:generate`');
  process.exit(1);
}
if (!CHECK_ONLY) {
  const paths = Object.keys(document.paths as Record<string, unknown>).length;
  console.log(`[openapi] ${paths} paths, ${contract.operator.methods.length} methods, ${untyped.size} marked untyped-client-io`);
}
if (CHECK_ONLY && !drifted) console.log('[openapi] artifacts up-to-date');
