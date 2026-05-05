import { describe, expect, test } from 'bun:test';
import { OPERATOR_METHOD_IDS } from '../packages/contracts/dist/index.js';
import * as ContractZodSchemas from '../packages/contracts/dist/index.js';
import { buildSchemaRegistry, methodIdToSchemaName } from '../packages/operator-sdk/src/schema-registry.js';

describe('operator-sdk schema registry', () => {
  describe('methodIdToSchemaName', () => {
    test('converts simple dot-separated ids', () => {
      expect(methodIdToSchemaName('control.status')).toBe('ControlStatusResponseSchema');
      expect(methodIdToSchemaName('accounts.snapshot')).toBe('AccountsSnapshotResponseSchema');
    });

    test('converts multi-segment dot ids', () => {
      expect(methodIdToSchemaName('control.auth.login')).toBe('ControlAuthLoginResponseSchema');
      expect(methodIdToSchemaName('control.auth.current')).toBe('ControlAuthCurrentResponseSchema');
    });

    test('converts snake_case namespace segments correctly', () => {
      // Preserve the canonical "local_auth.status" namespace rather than
      // splitting snake_case segments into extra dots.
      expect(methodIdToSchemaName('local_auth.status')).toBe('LocalAuthStatusResponseSchema');
    });
  });

  describe('buildSchemaRegistry', () => {
    const registry = buildSchemaRegistry(
      OPERATOR_METHOD_IDS as readonly string[],
      ContractZodSchemas as Record<string, unknown>,
    );

    const EXPECTED_METHODS = [
      'accounts.snapshot',
      'control.auth.current',
      'control.auth.login',
      'control.status',
      'local_auth.status',
    ] as const;

    for (const methodId of EXPECTED_METHODS) {
      test(`resolves schema for "${methodId}"`, () => {
        const schema = registry[methodId];
        expect(schema).not.toBeUndefined(); // presence-only: schema registered for method
        // Confirm it is a real Zod schema by checking the safeParse surface
        expect(typeof (schema as { safeParse?: unknown })?.safeParse).toBe('function');
      });
    }

    test('does not register non-contract schemas under wrong keys', () => {
      // The incorrect derivation of local_auth.status was "local.auth.status" -
      // verify that key is absent from the registry.
      expect(registry['local.auth.status']).toBeUndefined();
    });

    test('registry only contains entries for known contract methods', () => {
      const methodIdSet = new Set<string>(OPERATOR_METHOD_IDS);
      for (const key of Object.keys(registry)) {
        expect(methodIdSet.has(key)).toBe(true);
      }
    });
  });
});
