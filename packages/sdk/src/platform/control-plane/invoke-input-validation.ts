/**
 * invoke-input-validation.ts (W3-S1, Part B)
 *
 * A central, catalog-driven input gate for the gateway invoke layer. Before a
 * resolved verb's handler (or its HTTP delegate) runs, the invocation's params
 * are validated against the method catalog's `inputSchema`, returning an honest
 * 400 instead of letting a wrong-typed or missing-required field reach a handler
 * that would silently coerce or misbehave.
 *
 * Scope is deliberately the TYPED subset only:
 *   - Object schemas that declare `properties` are structurally validated.
 *   - Generic object schemas (object with no `properties`, e.g. an
 *     additionalProperties-only "any JSON object") pass through unchanged — the
 *     status quo — so no verb is falsely rejected for extra fields.
 *   - A verb with no `inputSchema` is untyped and passes through.
 *
 * The validator is lenient on unknown keys (does NOT enforce
 * `additionalProperties: false`): the goal is to reject provable type/shape
 * mismatches, not to tighten every loose handler that historically tolerated
 * extra fields. It reports the first violation it finds.
 */

import type { GatewayMethodDescriptor } from './method-catalog-shared.js';

/** Structured result of a rejected invocation — same 400 shape the router uses. */
export interface InvokeValidationError {
  readonly code: 'INVALID_INPUT';
  readonly detail: string;
}

/** How a descriptor's inputSchema is treated by the validate gate. */
export type InvokeValidationDisposition = 'validated' | 'generic' | 'untyped';

/**
 * A "generic" object schema declares `type: 'object'` but no `properties` map
 * (e.g. JSON_OBJECT_SCHEMA / an additionalProperties-only bag). Mirrors
 * operator-contract.ts:isGenericObjectSchema so coverage accounting and the gate
 * agree on what counts as typed.
 */
function isGenericObjectSchema(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && schema.type === 'object' && !Object.hasOwn(schema, 'properties'));
}

/**
 * Classify an inputSchema for both the validate gate and coverage accounting:
 *   - 'validated' — an object schema with declared properties (structurally checked)
 *   - 'generic'   — an object schema with no properties (skipped)
 *   - 'untyped'   — absent, or a non-object root we do not structurally validate (skipped)
 */
export function classifyInputSchema(schema: Record<string, unknown> | undefined): InvokeValidationDisposition {
  if (schema === undefined) return 'untyped';
  if (isGenericObjectSchema(schema)) return 'generic';
  if (schema.type === 'object' && Object.hasOwn(schema, 'properties')) return 'validated';
  return 'untyped';
}

function schemaLabel(path: string): string {
  return path === '' ? 'value' : path;
}

function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * Validate `value` against a JSON-schema-like `schema`. Returns a human-readable
 * detail string for the first violation, or null when the value conforms. Schema
 * forms without a `type` keyword (e.g. the empty "any JSON value" schema), or
 * with an unrecognized `type`, are treated as permissive (accept).
 */
function validateValue(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (branch && typeof branch === 'object' && validateValue(value, branch as Record<string, unknown>, path) === null) {
        return null;
      }
    }
    return `${schemaLabel(path)} did not match any of the allowed types`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${schemaLabel(path)} must be one of ${JSON.stringify(schema.enum)}`;
  }

  const type = schema.type;
  if (typeof type !== 'string') return null; // no type constraint → accept

  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `${schemaLabel(path)} must be a string`;
    case 'number':
    case 'integer':
      return typeof value === 'number' && !Number.isNaN(value)
        ? null
        : `${schemaLabel(path)} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${schemaLabel(path)} must be a boolean`;
    case 'null':
      return value === null ? null : `${schemaLabel(path)} must be null`;
    case 'array': {
      if (!Array.isArray(value)) return `${schemaLabel(path)} must be an array`;
      const items = schema.items;
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        for (let i = 0; i < value.length; i++) {
          const detail = validateValue(value[i], items as Record<string, unknown>, `${schemaLabel(path)}[${i}]`);
          if (detail) return detail;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${schemaLabel(path)} must be an object`;
      }
      const record = value as Record<string, unknown>;
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required) {
        if (typeof key === 'string' && (!(key in record) || record[key] === undefined)) {
          return `${childPath(path, key)} is required`;
        }
      }
      const properties = (schema.properties && typeof schema.properties === 'object')
        ? schema.properties as Record<string, unknown>
        : {};
      for (const [key, propValue] of Object.entries(record)) {
        const propSchema = properties[key];
        if (propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
          const detail = validateValue(propValue, propSchema as Record<string, unknown>, childPath(path, key));
          if (detail) return detail;
        }
        // Unknown keys are tolerated (lenient on additionalProperties) so loose
        // handlers that historically accepted extra fields are not broken.
      }
      return null;
    }
    default:
      return null; // unrecognized type keyword → accept
  }
}

/**
 * Validate an invocation's params against a verb's inputSchema. Returns an
 * `InvokeValidationError` when a typed schema is violated, or null when the
 * params conform, the schema is generic/untyped, or there is nothing to check.
 *
 * `params` is the request payload the verb receives (the invoke body for
 * body-carrying verbs). `undefined` is treated as an empty object so a schema
 * with required fields honestly reports them missing.
 */
export function validateInvocationInput(
  descriptor: GatewayMethodDescriptor,
  params: unknown,
): InvokeValidationError | null {
  const schema = descriptor.inputSchema;
  if (classifyInputSchema(schema) !== 'validated') return null;
  const value = params === undefined ? {} : params;
  const detail = validateValue(value, schema as Record<string, unknown>, '');
  return detail ? { code: 'INVALID_INPUT', detail } : null;
}

/** Coverage tallies for the operator contract manifest: how many cataloged verbs
 *  the invoke input gate structurally validates vs skips (generic/untyped). */
export interface InvokeValidationCoverage {
  readonly methods: number;
  readonly validated: number;
  readonly skippedGeneric: number;
  readonly skippedUntyped: number;
}

export function summarizeInvokeValidationCoverage(
  methods: readonly GatewayMethodDescriptor[],
): InvokeValidationCoverage {
  let validated = 0;
  let skippedGeneric = 0;
  let skippedUntyped = 0;
  for (const method of methods) {
    switch (classifyInputSchema(method.inputSchema)) {
      case 'validated': validated += 1; break;
      case 'generic': skippedGeneric += 1; break;
      case 'untyped': skippedUntyped += 1; break;
    }
  }
  return { methods: methods.length, validated, skippedGeneric, skippedUntyped };
}
