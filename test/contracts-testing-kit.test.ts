/**
 * contracts-testing-kit.test.ts
 *
 * Proves the shipped @pellux/goodvibes-contracts/testing surface (Stage B): the
 * descriptor/handler conformance kit and the mock-daemon fixture generator, plus
 * the checked-in generated fixture artifact.
 *
 *   1. conformance kit — the single source terminal-shell/tui/agent now share.
 *   2. mock-daemon generator — every cataloged method gets a schema-valid sample,
 *      generated from the contract's own output schemas.
 *   3. generated fixtures — MOCK_DAEMON_FIXTURES covers every method and is in
 *      sync with a fresh generation (the in-test half of the drift guard).
 */
import { describe, expect, test } from 'bun:test';
import {
  assertEveryDescriptorHasHandler,
  findMethodsMissingHandlers,
  sampleFromSchema,
  buildMockDaemonResponses,
  buildMockDaemonFixtureMap,
  createMockDaemon,
} from '@pellux/goodvibes-contracts/testing';
import { MOCK_DAEMON_FIXTURES } from '@pellux/goodvibes-contracts/generated/mock-daemon-fixtures';
import { OPERATOR_CONTRACT } from '@pellux/goodvibes-contracts/generated/operator-contract';
import { OPERATOR_METHOD_IDS } from '@pellux/goodvibes-contracts/generated/operator-method-ids';

// A compact validator for the JSON Schema subset the contract emits, enough to
// assert a generated sample actually satisfies its schema.
function isSchemaValid(schema: unknown, value: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s['anyOf'])) {
    return (s['anyOf'] as unknown[]).some((branch) => isSchemaValid(branch, value));
  }
  if (Array.isArray(s['enum'])) {
    return (s['enum'] as unknown[]).some((allowed) => allowed === value);
  }
  switch (s['type']) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const props = (s['properties'] as Record<string, unknown> | undefined) ?? {};
      const required = (s['required'] as string[] | undefined) ?? [];
      const obj = value as Record<string, unknown>;
      for (const key of required) if (!(key in obj)) return false;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj && !isSchemaValid(propSchema, obj[key])) return false;
      }
      return true;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      const items = s['items'];
      return items ? value.every((item) => isSchemaValid(items, item)) : true;
    }
    case 'string': return typeof value === 'string';
    case 'number':
    case 'integer': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

describe('contracts testing kit — conformance gate', () => {
  const fakeCatalog = (entries: ReadonlyArray<{ id: string; handled: boolean }>) => {
    const handled = new Set(entries.filter((e) => e.handled).map((e) => e.id));
    return { list: () => entries.map((e) => ({ id: e.id })), hasHandler: (id: string) => handled.has(id) };
  };

  test('passes when every descriptor has a handler', () => {
    const catalog = fakeCatalog([{ id: 'a.one', handled: true }, { id: 'a.two', handled: true }]);
    expect(findMethodsMissingHandlers(catalog)).toEqual([]);
    expect(() => assertEveryDescriptorHasHandler(catalog)).not.toThrow();
  });

  test('names the handler-less descriptors and throws', () => {
    const catalog = fakeCatalog([{ id: 'a.one', handled: true }, { id: 'b.two', handled: false }]);
    expect(findMethodsMissingHandlers(catalog)).toEqual(['b.two']);
    expect(() => assertEveryDescriptorHasHandler(catalog)).toThrow(/b\.two/);
  });
});

describe('contracts testing kit — mock-daemon generator', () => {
  test('sampleFromSchema handles the emitted JSON Schema subset', () => {
    expect(sampleFromSchema({ type: 'string' })).toBe('sample');
    expect(sampleFromSchema({ type: 'number' })).toBe(0);
    expect(sampleFromSchema({ type: 'boolean' })).toBe(false);
    expect(sampleFromSchema({ type: 'string', enum: ['plan', 'auto'] })).toBe('plan');
    expect(sampleFromSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] })).toBe('sample');
    expect(sampleFromSchema({ type: 'array', items: { type: 'number' } })).toEqual([0]);
    expect(sampleFromSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'boolean' } },
      required: ['a'],
    })).toEqual({ a: 'sample', b: false });
  });

  test('every cataloged method gets a sample response, and each is schema-valid', () => {
    const responses = buildMockDaemonResponses(OPERATOR_CONTRACT);
    expect(responses.length).toBe(OPERATOR_CONTRACT.operator.methods.length);
    const byId = new Map(OPERATOR_CONTRACT.operator.methods.map((m) => [m.id, m] as const));
    const invalid: string[] = [];
    for (const response of responses) {
      const method = byId.get(response.methodId)!;
      if (method.outputSchema && !isSchemaValid(method.outputSchema, response.body)) {
        invalid.push(response.methodId);
      }
    }
    expect(invalid).toEqual([]);
  });

  test('createMockDaemon answers by methodId and by HTTP method+path', () => {
    const daemon = createMockDaemon(OPERATOR_CONTRACT);
    const withHttp = OPERATOR_CONTRACT.operator.methods.find((m) => m.http);
    expect(withHttp).toBeDefined();
    const byId = daemon.answer(withHttp!.id);
    expect(byId?.status).toBe(200);
    const byHttp = daemon.answerHttp(withHttp!.http!.method, withHttp!.http!.path);
    expect(byHttp?.methodId).toBe(withHttp!.id);
    expect(daemon.answer('nonexistent.method')).toBeNull();
  });
});

describe('contracts testing kit — generated fixtures', () => {
  test('MOCK_DAEMON_FIXTURES covers every operator method id', () => {
    const covered = Object.keys(MOCK_DAEMON_FIXTURES).sort();
    expect(covered).toEqual([...OPERATOR_METHOD_IDS].sort());
  });

  test('the checked-in fixtures match a fresh generation (drift guard)', () => {
    expect(MOCK_DAEMON_FIXTURES).toEqual(buildMockDaemonFixtureMap(OPERATOR_CONTRACT));
  });
});
