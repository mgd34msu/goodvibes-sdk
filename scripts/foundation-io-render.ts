// foundation-io-render.ts
//
// The JSON-Schema -> TypeScript type-string renderer used to produce the
// OperatorMethodInputMap / OperatorMethodOutputMap entries in
// packages/contracts/src/generated/foundation-client-types.ts.
//
// Extracted verbatim from check-foundation-io-types.ts so the drift CHECK and
// the ENTRY GENERATOR (generate-foundation-io-entries.ts) render through one
// implementation rather than two that can disagree. Keeping the counting rules
// in a pure module mirrors foundation-io-coverage-rule.ts vs
// check-foundation-io-coverage.ts.
//
// Scope: intentionally NOT a general JSON-Schema-to-TS compiler. It implements
// the constructs actually present in the method-catalog schemas: string/number/
// boolean/null primitives, sorted string enums, arrays, nullable (anyOf [X,
// {type:'null'}]), general unions, plain objects with required/optional fields,
// additionalProperties true/false/schema, and the JSON-value family (identity-
// matched, since those schemas are self-referential and structural recursion
// would never terminate). A construct it does not understand throws rather than
// guessing, a loud failure, not a silent wrong render.

import {
  JSON_ARRAY_SCHEMA,
  JSON_OBJECT_SCHEMA,
  JSON_VALUE_SCHEMA,
} from '../packages/sdk/src/platform/control-plane/method-catalog-shared.ts';
import { METADATA_SCHEMA } from '../packages/sdk/src/platform/control-plane/operator-contract-schemas-shared.ts';

/** Renders a single schema node to the TS type-string convention used in foundation-client-types.ts. */
export function renderType(schema: Record<string, unknown>): string {
  // METADATA_SCHEMA (JSON_RECORD_SCHEMA) is rendered as a fixed literal
  // throughout the existing file (verified identical at dozens of call
  // sites, e.g. artifacts.create/get/list, approvals.*, sessions.close, etc).
  if (schema === (METADATA_SCHEMA as unknown as Record<string, unknown>)) {
    return '({  } & { readonly [key: string]: ({  } & { readonly [key: string]: JsonValue }) | boolean | null | number | readonly JsonValue[] | string })';
  }

  // The self-referential JSON-value family renders as the fixed literals the
  // existing file uses everywhere (verified against the committed entries),
  // identity-matched, because structural recursion would never terminate.
  if (schema === (JSON_VALUE_SCHEMA as unknown as Record<string, unknown>)) {
    return '({  } & { readonly [key: string]: JsonValue }) | boolean | null | number | readonly JsonValue[] | string';
  }
  if (schema === (JSON_OBJECT_SCHEMA as unknown as Record<string, unknown>)) {
    return '({  } & { readonly [key: string]: JsonValue })';
  }
  if (schema === (JSON_ARRAY_SCHEMA as unknown as Record<string, unknown>)) {
    return 'readonly JsonValue[]';
  }

  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) {
    const branches = (schema as { anyOf: Record<string, unknown>[] }).anyOf;

    // A base object schema carrying an `anyOf` whose branches are PURE
    // required-key refinements ({ required: [...] } and nothing else) is the
    // JSON-Schema idiom for "at least one of these keys must be present"
    // (knowledge.ingest.connector: one of input/content/path). It is not a
    // union of independent shapes, so rendering the bare branches would throw
    // on a node with no `type`. Render it as the union of the base object with
    // each branch's keys promoted to required, the honest TS equivalent.
    const isPureRequiredRefinement = (branch: Record<string, unknown>) =>
      Array.isArray(branch.required) && Object.keys(branch).length === 1;
    if (
      schema.type === 'object' &&
      branches.length > 0 &&
      branches.every(isPureRequiredRefinement)
    ) {
      const baseRequired = (schema.required as string[] | undefined) ?? [];
      const { anyOf: _dropped, ...base } = schema as Record<string, unknown> & { anyOf: unknown };
      return branches
        .map((branch) =>
          renderType({
            ...base,
            required: [...baseRequired, ...(branch.required as string[])],
          }),
        )
        .join(' | ');
    }

    if (branches.length === 2 && branches.some((b) => b.type === 'null')) {
      const other = branches.find((b) => b.type !== 'null')!;
      return `null | ${renderType(other)}`;
    }
    if (branches.length === 0) throw new Error(`Unsupported anyOf shape: ${JSON.stringify(schema)}`);
    // A general (e.g. discriminated) union: branches in declaration order,
    // each rendered by the same rules, joined with ' | '. Needed for the
    // approval request's attribution union (approvals.* entries).
    const { anyOf: _unionDropped, ...unionBase } = schema as Record<string, unknown> & { anyOf: unknown };
    const union = branches.map((branch) => renderType(branch)).join(' | ');
    // `anyOf` alongside a base object is a conjunction, not a replacement: the
    // base says what the input IS and the branches say which of its optional
    // fields this alternative makes mandatory (see method-catalog-shared.ts
    // `branchedSchema`). Rendering only the branches would silently drop every
    // property the base declares.
    const hasBase = unionBase.type === 'object' && Object.hasOwn(unionBase, 'properties');
    if (!hasBase) return union;
    // Each branch is `additionalProperties: true` because the PUBLISHED schema
    // has to be (see method-catalog-shared.ts `requirementBranch`), but the base
    // it intersects with already contributes the index signature. Emitting it
    // again per branch says nothing new and multiplies the type: repeating it is
    // what put the operator client's method map over TypeScript's
    // union-complexity limit. So the branches render closed and the openness
    // comes from the base.
    const leanUnion = branches
      .map((branch) => renderType({ ...branch, additionalProperties: false }))
      .join(' | ');
    return `${renderType(unionBase)} & (${leanUnion})`;
  }

  if (schema.type === 'string') {
    if (Array.isArray(schema.enum)) {
      const sorted = [...(schema.enum as string[])].sort();
      return sorted.map((v) => `"${v}"`).join(' | ');
    }
    return 'string';
  }
  if (schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';

  if (schema.type === 'array') {
    const items = (schema as { items: Record<string, unknown> }).items;
    const itemType = renderType(items);
    const isBarePrimitive =
      (items.type === 'string' && !Array.isArray(items.enum)) ||
      items.type === 'number' ||
      items.type === 'boolean';
    return isBarePrimitive ? `readonly ${itemType}[]` : `readonly (${itemType})[]`;
  }

  if (schema.type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const fields = Object.entries(properties)
      .map(([key, valueSchema]) => {
        const optional = required.has(key) ? '' : '?';
        return `${key}${optional}: ${renderType(valueSchema)};`;
      })
      .join(' ');
    const body = fields.length > 0 ? `{ ${fields} }` : '{  }';
    if (schema.additionalProperties === true) {
      return `(${body} & { readonly [key: string]: unknown })`;
    }
    // A SCHEMA-valued additionalProperties is a record whose values all satisfy
    // that schema, the shape the existing file already renders for
    // JSON_OBJECT_SCHEMA and METADATA_SCHEMA above, generalized.
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
    ) {
      const valueType = renderType(schema.additionalProperties as Record<string, unknown>);
      return `(${body} & { readonly [key: string]: ${valueType} })`;
    }
    return body;
  }

  throw new Error(`Unsupported schema node: ${JSON.stringify(schema)}`);
}
