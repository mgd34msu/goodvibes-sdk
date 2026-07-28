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

function methodContract(id: string, verb: string, path: string): OperatorMethodContract {
  return {
    id,
    title: id,
    description: id,
    source: 'daemon',
    access: 'admin',
    transport: ['http'],
    http: { method: verb, path },
    scopes: [],
  } as unknown as OperatorMethodContract;
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
    expect(() => buildRoutes([methodContract('m.put', 'PUT', '/v1/put')])).toThrow(/PUT/);
  });

  test('a method with no http binding is skipped, not rejected', () => {
    const wsOnly = { ...methodContract('m.ws', 'GET', '/x'), http: null } as unknown as OperatorMethodContract;
    expect(buildRoutes([wsOnly])).toEqual({});
  });
});
