/**
 * generated-consumer-transports.test.ts
 *
 * Proves the Stage-C generated consumer transport layers are complete, honest,
 * and in sync with the committed operator contract:
 *
 *   webui facade (packages/contracts/src/generated/webui-facade.ts)
 *     - WEBUI_METHOD_ROUTES covers exactly the REST-bound methods, verbatim.
 *     - WEBUI_WS_INVOKE_METHOD_IDS is exactly the ws-only (no http) set.
 *     - WEBUI_METHOD_DISPOSITION classifies every method.
 *     - WEBUI_METHOD_SAMPLES has a generated input/output sample per method.
 *     - the checked-in module matches a fresh generation (in-test drift guard).
 *
 *   HA Python client (packages/contracts/artifacts/python/homeassistant_operator_client.py)
 *     - the emitted file parses (py_compile when python3 is present).
 *     - CONSUMED_METHOD_IDS is the inventoried subset and every id exists.
 *     - OPERATOR_ROUTES entries match the contract http bindings verbatim.
 *     - CONTRACT_VERSION equals the committed contract's product version
 *       (artifact vs artifact — never the live build VERSION).
 *     - a TypedDict/alias pair is emitted per consumed method.
 *     - the checked-in file matches a fresh generation (in-test drift guard).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  WEBUI_METHOD_ROUTES,
  WEBUI_WS_INVOKE_METHOD_IDS,
  WEBUI_METHOD_DISPOSITION,
  WEBUI_METHOD_SAMPLES,
} from '../packages/contracts/src/generated/webui-facade.ts';
import {
  render as renderWebui,
  loadContract as loadWebuiContract,
  buildRoutes,
  buildWsInvokeIds,
  buildSamples,
  WEBUI_FACADE_OUT_PATH,
} from '../scripts/generate-webui-facade.ts';
import {
  render as renderHa,
  loadContract as loadHaContract,
  consumedIdsFor,
  HA_CLIENT_OUT_PATH,
} from '../scripts/generate-homeassistant-client.ts';

const contract = loadWebuiContract();
const methods = contract.operator.methods;

describe('webui facade — REST vs ws disposition', () => {
  test('WEBUI_METHOD_ROUTES is exactly the REST-bound methods, verbatim', () => {
    const expected = buildRoutes(methods);
    expect(WEBUI_METHOD_ROUTES).toEqual(expected);
    // Cross-check a couple against the raw contract so the expectation is grounded.
    for (const method of methods) {
      if (method.http) {
        expect(WEBUI_METHOD_ROUTES[method.id]).toEqual({ method: method.http.method, path: method.http.path });
      } else {
        expect(WEBUI_METHOD_ROUTES[method.id]).toBeUndefined();
      }
    }
  });

  test('WEBUI_WS_INVOKE_METHOD_IDS is exactly the ws-only (no http) set', () => {
    expect([...WEBUI_WS_INVOKE_METHOD_IDS]).toEqual(buildWsInvokeIds(methods));
    for (const id of WEBUI_WS_INVOKE_METHOD_IDS) {
      const method = methods.find((m) => m.id === id)!;
      expect(method.http).toBeUndefined();
      expect(method.transport).toContain('ws');
    }
  });

  test('WEBUI_METHOD_DISPOSITION classifies every cataloged method', () => {
    expect(Object.keys(WEBUI_METHOD_DISPOSITION).sort()).toEqual(methods.map((m) => m.id).sort());
    for (const method of methods) {
      expect(WEBUI_METHOD_DISPOSITION[method.id]).toBe(method.http ? 'rest' : 'ws-invoke');
    }
  });

  test('WEBUI_METHOD_SAMPLES has a generated input/output sample per method', () => {
    expect(Object.keys(WEBUI_METHOD_SAMPLES).sort()).toEqual(methods.map((m) => m.id).sort());
    expect(WEBUI_METHOD_SAMPLES).toEqual(buildSamples(methods));
  });
});

describe('webui facade — drift guard', () => {
  test('the checked-in module matches a fresh generation', () => {
    const onDisk = readFileSync(WEBUI_FACADE_OUT_PATH, 'utf8');
    expect(onDisk).toBe(renderWebui(contract));
  });
});

describe('HA python client — generated transport', () => {
  const haContract = loadHaContract();
  const py = readFileSync(HA_CLIENT_OUT_PATH, 'utf8');
  const consumed = consumedIdsFor(haContract);
  const byId = new Map(haContract.operator.methods.map((m) => [m.id, m] as const));

  test('the emitted Python file parses', () => {
    const python = Bun.which('python3');
    if (python) {
      const result = spawnSync(python, ['-m', 'py_compile', HA_CLIENT_OUT_PATH], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    }
    // Structural smoke: the module always carries its landmark declarations.
    expect(py).toContain('CONTRACT_VERSION: str =');
    expect(py).toContain('class OperatorRoute(NamedTuple):');
    expect(py).toContain('OPERATOR_ROUTES: dict[str, OperatorRoute] =');
  });

  test('CONTRACT_VERSION equals the committed contract product version', () => {
    // Artifact vs artifact — decoupled from the live build VERSION.
    expect(py).toContain(`CONTRACT_VERSION: str = ${JSON.stringify(haContract.product.version)}`);
  });

  test('CONSUMED_METHOD_IDS is the inventoried subset and every id exists', () => {
    for (const id of consumed) {
      expect(byId.has(id)).toBe(true);
      expect(py).toContain(`    ${JSON.stringify(id)},`);
    }
    // The homeassistant.* surface is fully consumed.
    const haOnly = haContract.operator.methods.filter((m) => m.id.startsWith('homeassistant.')).map((m) => m.id);
    for (const id of haOnly) expect(consumed).toContain(id);
  });

  test('OPERATOR_ROUTES entries match the contract http bindings verbatim', () => {
    for (const id of consumed) {
      const http = byId.get(id)!.http!;
      expect(py).toContain(`${JSON.stringify(id)}: OperatorRoute(${JSON.stringify(http.method)}, ${JSON.stringify(http.path)}),`);
    }
  });

  test('a TypedDict or alias pair is emitted per consumed method', () => {
    for (const id of consumed) {
      const stem = id.split(/[^a-zA-Z0-9]+/).filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
      // Either a TypedDict class or a Mapping alias, for both input and output.
      expect(py).toMatch(new RegExp(`(class ${stem}Input\\(TypedDict|${stem}Input = )`));
      expect(py).toMatch(new RegExp(`(class ${stem}Output\\(TypedDict|${stem}Output = )`));
    }
  });

  test('the checked-in file matches a fresh generation (drift guard)', () => {
    const fresh = renderHa(haContract);
    expect(py).toBe(fresh.endsWith('\n') ? fresh : `${fresh}\n`);
  });
});
