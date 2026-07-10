/**
 * openapi-operator-contract.test.ts
 *
 * Proves the published OpenAPI 3.1 operator contract is complete and honest:
 *
 *   - every cataloged operator method appears (REST-bound methods as path
 *     operations, invoke-only methods listed on the generic invoke endpoint,
 *     and ALL methods in the x-operator-methods index);
 *   - the untyped-client-IO methods are marked `x-typed-client-io: false` and
 *     their count equals the foundation-io ratchet's untyped set — honestly
 *     present, never omitted;
 *   - the docs/ copy and the package artifact are byte-identical;
 *   - auth schemes mirror the contract's auth block.
 *
 * Version-decoupled: assertions compare committed artifacts to each other
 * (operator-openapi.json vs operator-contract.json), never to the live build
 * VERSION.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMapKeys, parseMethodIds, untypedMethodIds } from '../scripts/foundation-io-coverage-rule.ts';

const ROOT = join(import.meta.dir, '..');
const openapiText = readFileSync(join(ROOT, 'packages/contracts/artifacts/operator-openapi.json'), 'utf8');
const docsText = readFileSync(join(ROOT, 'docs/operator-openapi.json'), 'utf8');

interface MethodIndexEntry {
  id: string;
  rest: string | null;
  typedClientIo: boolean;
  inputSchemaCoverage: string;
  outputSchemaCoverage: string;
}

const doc = JSON.parse(openapiText) as {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, { operationId?: string; 'x-typed-client-io'?: boolean; 'x-invoke-only-methods'?: string[] }>>;
  components: { securitySchemes: Record<string, { type: string; name?: string }> };
  'x-untyped-client-io-count': number;
  'x-operator-methods': MethodIndexEntry[];
};

const contract = JSON.parse(
  readFileSync(join(ROOT, 'packages/contracts/artifacts/operator-contract.json'), 'utf8'),
) as {
  product: { version: string };
  auth: { sessionCookie: { name: string } };
  operator: { methods: { id: string; http?: { method: string; path: string } }[] };
};

function ratchetUntypedSet(): Set<string> {
  const foundationText = readFileSync(join(ROOT, 'packages/contracts/src/generated/foundation-client-types.ts'), 'utf8');
  const idsText = readFileSync(join(ROOT, 'packages/contracts/src/generated/operator-method-ids.ts'), 'utf8');
  return new Set(
    untypedMethodIds(
      parseMethodIds(idsText),
      parseMapKeys(foundationText, 'OperatorMethodInputMap'),
      parseMapKeys(foundationText, 'OperatorMethodOutputMap'),
    ),
  );
}

describe('published OpenAPI operator contract', () => {
  test('is OpenAPI 3.1 and carries the contract product version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(contract.product.version);
  });

  test('every cataloged method appears in the index; REST-bound ones as operations', () => {
    const methods = contract.operator.methods;
    expect(doc['x-operator-methods'].length).toBe(methods.length);
    const indexIds = new Set(doc['x-operator-methods'].map((m) => m.id));
    for (const m of methods) expect(indexIds.has(m.id)).toBe(true);

    const operationIds = new Set<string>();
    for (const pathItem of Object.values(doc.paths)) {
      for (const op of Object.values(pathItem)) {
        if (op.operationId) operationIds.add(op.operationId);
      }
    }
    for (const m of methods.filter((x) => x.http)) {
      expect(operationIds.has(m.id)).toBe(true);
    }
  });

  test('invoke-only methods are listed on the generic invoke endpoint, not dropped', () => {
    const invokeOp = doc.paths['/api/control/gateway-methods/{methodId}/invoke']?.post;
    expect(invokeOp).toBeDefined();
    const listed = new Set(invokeOp!['x-invoke-only-methods'] ?? []);
    const invokeOnly = contract.operator.methods.filter((m) => !m.http);
    expect(listed.size).toBe(invokeOnly.length);
    for (const m of invokeOnly) expect(listed.has(m.id)).toBe(true);
  });

  test('the untyped-client-IO methods are honestly marked and match the ratchet set', () => {
    const untyped = ratchetUntypedSet();
    expect(doc['x-untyped-client-io-count']).toBe(untyped.size);
    const markedUntyped = doc['x-operator-methods'].filter((m) => !m.typedClientIo);
    expect(markedUntyped.length).toBe(untyped.size);
    for (const entry of markedUntyped) expect(untyped.has(entry.id)).toBe(true);
    // and they are NOT omitted from the operation set when REST-bound
    for (const entry of markedUntyped) {
      if (!entry.rest) continue;
      const [verb, path] = entry.rest.split(' ') as [string, string];
      const op = doc.paths[path]?.[verb.toLowerCase()];
      expect(op?.operationId).toBe(entry.id);
      expect(op?.['x-typed-client-io']).toBe(false);
    }
  });

  test('auth schemes mirror the contract auth block', () => {
    expect(doc.components.securitySchemes.bearerAuth?.type).toBe('http');
    expect(doc.components.securitySchemes.sessionCookie?.name).toBe(contract.auth.sessionCookie.name);
  });

  test('the docs/ copy is byte-identical to the package artifact', () => {
    expect(docsText).toBe(openapiText);
  });
});
