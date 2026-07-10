/**
 * testing/mock-daemon.ts — generate schema-valid sample responses for every
 * cataloged operator method, straight from the contract's own JSON Schemas.
 *
 * Consumers (the webui Playwright suite, the Home Assistant test fixtures) have
 * historically hand-written a mock response per method their UI calls, which
 * drifts silently the moment a method's output schema changes. This generator
 * removes the hand-authoring: given the operator contract manifest, it walks
 * each method's `outputSchema` and produces a minimal, deterministic,
 * schema-valid body — the single source those mocks can be generated from.
 *
 * The walk is deterministic (no randomness, no clock) so a regenerated fixture
 * set is byte-identical unless the contract itself changed — the property that
 * lets a checked-in fixture artifact carry a drift check.
 *
 * Scope: this understands the JSON Schema subset the contract generator emits —
 * object (properties/required), array (items), string (enum), number/integer,
 * boolean, null, and anyOf unions. It is a fixture generator, not a full JSON
 * Schema materializer; an unrecognized shape yields null rather than throwing,
 * so a new schema keyword degrades to a still-valid (if minimal) sample.
 */
import type { JsonSchema, OperatorContractManifest } from '../types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Produce a minimal, deterministic value that satisfies `schema`. Fills every
 * declared object property (required and optional) so the sample exercises the
 * full shape a consumer's mock renders.
 */
export function sampleFromSchema(schema: JsonSchema | undefined): unknown {
  if (!schema) return null;
  const record = asRecord(schema);
  if (!record) return null;

  // anyOf union: take the first branch that is not a bare `null` type, so the
  // sample carries a representative value rather than degenerating to null.
  const anyOf = record['anyOf'];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const branches = anyOf as JsonSchema[];
    const preferred = branches.find((branch) => asRecord(branch)?.['type'] !== 'null') ?? branches[0];
    return sampleFromSchema(preferred);
  }

  const enumValues = record['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[0];
  }

  const type = record['type'];

  if (type === 'object' || (type === undefined && asRecord(record['properties']))) {
    const properties = asRecord(record['properties']) ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      out[key] = sampleFromSchema(propSchema as JsonSchema);
    }
    return out;
  }

  if (type === 'array') {
    const items = record['items'];
    if (items && !Array.isArray(items)) {
      return [sampleFromSchema(items as JsonSchema)];
    }
    return [];
  }

  switch (type) {
    case 'string':
      return 'sample';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      // Unknown / absent type with no properties: JSON Schema's "accept anything".
      return null;
  }
}

/** One generated mock response: what a daemon would answer for a method. */
export interface MockDaemonResponse {
  readonly methodId: string;
  readonly http: { readonly method: string; readonly path: string } | null;
  readonly status: number;
  readonly body: unknown;
}

/**
 * Build a schema-valid sample response for every method in the contract, in
 * catalog order. A method with no `outputSchema` yields a `null` body (honest:
 * the contract declares no shape to sample).
 */
export function buildMockDaemonResponses(contract: OperatorContractManifest): MockDaemonResponse[] {
  return contract.operator.methods.map((method) => ({
    methodId: method.id,
    http: method.http ? { method: method.http.method, path: method.http.path } : null,
    status: 200,
    body: sampleFromSchema(method.outputSchema),
  }));
}

/** A methodId -> sample response map, the fixture shape most consumers want. */
export type MockDaemonFixtureMap = Readonly<Record<string, MockDaemonResponse>>;

/** Reduce the response list to a methodId-keyed map. */
export function buildMockDaemonFixtureMap(contract: OperatorContractManifest): MockDaemonFixtureMap {
  const map: Record<string, MockDaemonResponse> = {};
  for (const response of buildMockDaemonResponses(contract)) {
    map[response.methodId] = response;
  }
  return map;
}

/**
 * A tiny in-memory mock daemon over the generated fixtures: answer by methodId
 * or by HTTP method+path. Returns null for an unknown method/route so a caller
 * can fall through to its own 404, exactly like a real dispatcher.
 */
export function createMockDaemon(contract: OperatorContractManifest): {
  answer(methodId: string): MockDaemonResponse | null;
  answerHttp(method: string, path: string): MockDaemonResponse | null;
} {
  const responses = buildMockDaemonResponses(contract);
  const byId = new Map(responses.map((response) => [response.methodId, response] as const));
  const byHttp = new Map(
    responses
      .filter((response) => response.http)
      .map((response) => [`${response.http!.method} ${response.http!.path}`, response] as const),
  );
  return {
    answer: (methodId) => byId.get(methodId) ?? null,
    answerHttp: (method, path) => byHttp.get(`${method.toUpperCase()} ${path}`) ?? null,
  };
}
