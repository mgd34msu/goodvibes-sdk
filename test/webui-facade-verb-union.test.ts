/**
 * The webui facade generator's HTTP-verb union, driven both ways.
 *
 * `RouteRow.method` used to be `string` while the emitted
 * `export type WebuiHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'` was a
 * hard-coded literal in a template string. A contract route on any other verb
 * would have been written into a facade that types the field as one of those
 * four while carrying something else, and nothing would have reported it. Both
 * now come from `WEBUI_HTTP_METHODS`.
 */
import { describe, expect, test } from 'bun:test';

import {
  WEBUI_HTTP_METHODS,
  buildRoutes,
  isWebuiHttpMethod,
} from '../scripts/generate-webui-facade.ts';
import type { OperatorMethodContract } from '../packages/contracts/src/types.ts';

/**
 * A real OperatorMethodContract, not a cast.
 *
 * This started as `{...} as unknown as OperatorMethodContract`, and the cast
 * was hiding two disagreements with the contract: `source: 'daemon'` is not a
 * GatewayMethodSource ('builtin' | 'plugin'), and the required `category` was
 * absent. `satisfies` keeps it honest, a field added upstream now breaks this
 * fixture instead of being silently absorbed.
 */
type ContractVerb = NonNullable<OperatorMethodContract['http']>['method'];

function methodContract(id: string, verb: ContractVerb, path: string): OperatorMethodContract {
  return {
    id,
    title: id,
    description: id,
    category: 'test',
    source: 'builtin',
    access: 'admin',
    transport: ['http'],
    http: { method: verb, path },
    scopes: [],
  } satisfies OperatorMethodContract;
}

/**
 * A contract carrying a verb the type system cannot express.
 *
 * `buildRoutes` runs against a contract JSON artifact that is read with
 * `JSON.parse` and asserted to the manifest type, so a verb outside the union
 * can reach it at runtime even though no well-typed literal can produce one.
 * The cast is confined to that single field and exists to construct invalid
 * input for a rejection test, not to make a fixture compile.
 */
function methodContractWithUnsupportedVerb(id: string, verb: string, path: string): OperatorMethodContract {
  const base = methodContract(id, 'GET', path);
  return { ...base, http: { method: verb as ContractVerb, path } };
}

describe('isWebuiHttpMethod', () => {
  test('accepts every verb the emitted union names', () => {
    for (const verb of WEBUI_HTTP_METHODS) expect(isWebuiHttpMethod(verb)).toBe(true);
  });

  test('rejects a verb it does not — the predicate can answer NO', () => {
    expect(isWebuiHttpMethod('PUT')).toBe(false);
    expect(isWebuiHttpMethod('get')).toBe(false); // case matters; the union is upper-case
    expect(isWebuiHttpMethod('')).toBe(false);
  });
});

describe('buildRoutes', () => {
  test('emits a route for each supported verb', () => {
    const routes = buildRoutes(WEBUI_HTTP_METHODS.map((verb, i) => methodContract(`m.${i}`, verb, `/v1/${i}`)));
    expect(Object.keys(routes)).toHaveLength(WEBUI_HTTP_METHODS.length);
    expect(routes['m.0']?.method).toBe('GET');
  });

  test('throws on a verb outside the union rather than emitting a mistyped facade', () => {
    expect(() => buildRoutes([methodContractWithUnsupportedVerb('m.put', 'PUT', '/v1/put')])).toThrow(/PUT/);
  });

  test('a method with no http binding is skipped, not rejected', () => {
    // `http` absent is how the contract expresses a ws-only method. It was
    // written as `http: null` behind a cast, a shape the contract does not
    // allow.
    const { http: _unrouted, ...wsOnly } = methodContract('m.ws', 'GET', '/x');
    expect(buildRoutes([wsOnly])).toEqual({});
  });
});
