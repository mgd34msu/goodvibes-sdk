/**
 * invoke-input-validation.test.ts (W3-S1, Part B)
 *
 * The catalog-driven invoke input gate: typed inputSchemas are structurally
 * validated (wrong type / missing required → honest error); generic and untyped
 * schemas pass through unchanged (no false rejection of extra fields); the
 * validator is lenient on unknown keys.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyInputSchema,
  summarizeInvokeValidationCoverage,
  validateInvocationInput,
} from '../packages/sdk/src/platform/control-plane/invoke-input-validation.js';
import {
  EMPTY_OBJECT_SCHEMA,
  JSON_OBJECT_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
  type GatewayMethodDescriptor,
} from '../packages/sdk/src/platform/control-plane/method-catalog-shared.js';

function verb(inputSchema: Record<string, unknown> | undefined): GatewayMethodDescriptor {
  return methodDescriptor({
    id: 'test.verb',
    title: 'Test Verb',
    description: 'A verb under test.',
    category: 'test',
    scopes: [],
    ...(inputSchema ? { inputSchema } : {}),
  });
}

describe('classifyInputSchema', () => {
  test('object schema with declared properties is validated', () => {
    expect(classifyInputSchema(objectSchema({ name: STRING_SCHEMA }, ['name']))).toBe('validated');
    expect(classifyInputSchema(EMPTY_OBJECT_SCHEMA)).toBe('validated'); // properties:{} present
    expect(classifyInputSchema(bodyEnvelopeSchema({ id: STRING_SCHEMA }, ['id']))).toBe('validated');
  });

  test('object schema with no properties is generic (skipped)', () => {
    expect(classifyInputSchema(JSON_OBJECT_SCHEMA)).toBe('generic');
    expect(classifyInputSchema({ type: 'object', additionalProperties: true })).toBe('generic');
  });

  test('absent schema is untyped (skipped)', () => {
    expect(classifyInputSchema(undefined)).toBe('untyped');
  });
});

describe('validateInvocationInput — typed schemas', () => {
  const schema = objectSchema({
    username: STRING_SCHEMA,
    count: NUMBER_SCHEMA,
    tags: arraySchema(STRING_SCHEMA),
  }, ['username']);

  test('wrong-typed field is rejected', () => {
    const result = validateInvocationInput(verb(schema), { username: 123 });
    expect(result?.code).toBe('INVALID_INPUT');
    expect(result?.detail).toContain('username');
  });

  test('missing required field is rejected', () => {
    const result = validateInvocationInput(verb(schema), { count: 3 });
    expect(result?.code).toBe('INVALID_INPUT');
    expect(result?.detail).toContain('username');
    expect(result?.detail).toContain('required');
  });

  test('undefined params is treated as {} → missing required reported', () => {
    const result = validateInvocationInput(verb(schema), undefined);
    expect(result?.code).toBe('INVALID_INPUT');
  });

  test('wrong element type inside an array is rejected', () => {
    const result = validateInvocationInput(verb(schema), { username: 'ok', tags: ['a', 7] });
    expect(result?.code).toBe('INVALID_INPUT');
    expect(result?.detail).toContain('tags[1]');
  });

  test('valid params pass', () => {
    expect(validateInvocationInput(verb(schema), { username: 'ok', count: 2, tags: ['x'] })).toBeNull();
  });

  test('optional field omitted still passes', () => {
    expect(validateInvocationInput(verb(schema), { username: 'ok' })).toBeNull();
  });

  test('extra unknown keys are tolerated (lenient additionalProperties)', () => {
    expect(validateInvocationInput(verb(schema), { username: 'ok', surprise: true })).toBeNull();
  });
});

describe('validateInvocationInput — pass-through schemas', () => {
  test('generic object schema is never rejected, even with extra fields', () => {
    expect(validateInvocationInput(verb(JSON_OBJECT_SCHEMA), { anything: 1, more: 'x' })).toBeNull();
  });

  test('untyped verb (no inputSchema) is never rejected', () => {
    expect(validateInvocationInput(verb(undefined), { whatever: [1, 2, 3] })).toBeNull();
  });
});

describe('summarizeInvokeValidationCoverage', () => {
  test('counts validated vs generic vs untyped', () => {
    const methods = [
      verb(objectSchema({ a: STRING_SCHEMA }, ['a'])),
      verb(objectSchema({ b: NUMBER_SCHEMA })),
      verb(JSON_OBJECT_SCHEMA),
      verb(undefined),
    ];
    const cov = summarizeInvokeValidationCoverage(methods);
    expect(cov.methods).toBe(4);
    expect(cov.validated).toBe(2);
    expect(cov.skippedGeneric).toBe(1);
    expect(cov.skippedUntyped).toBe(1);
  });
});
