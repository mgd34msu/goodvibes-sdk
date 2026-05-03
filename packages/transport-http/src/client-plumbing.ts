import { ContractError } from '@pellux/goodvibes-errors';

const MAX_SCHEMA_PATTERN_CHARS = 512;
const MAX_SCHEMA_PATTERN_INPUT_CHARS = 50_000;
const RISKY_SCHEMA_PATTERN_CHECKS: readonly RegExp[] = [
  /(^|[^\\])\\[1-9]/,
  /\((?:[^()\\]|\\.)*[+*{][^)]*\)\s*[+*{]/,
  /\.\*(?:[^|)]{0,64})\.\*/,
];

export type RequiredKeys<T extends object> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Maps a contract input object to the public client method argument tuple.
 * Required input fields make the first argument required; fully optional input
 * shapes keep it optional; `undefined` inputs expose only the options argument.
 */
export type MethodArgs<TInput, TOptions> =
  [TInput] extends [undefined]
    ? [input?: undefined, options?: TOptions]
    : TInput extends object
      ? [RequiredKeys<TInput>] extends [never]
        ? [input?: TInput, options?: TOptions]
        : [input: TInput, options?: TOptions]
      : [input: TInput, options?: TOptions];

/** Remove path-bound keys from a contract input before exposing method helpers. */
export type WithoutKeys<TInput, TKeys extends PropertyKey> =
  [TInput] extends [undefined]
    ? undefined
    : TInput extends object
      ? Omit<TInput, Extract<keyof TInput, TKeys>>
      : TInput;

/**
 * Splits a generated client helper's rest tuple into input and options.
 * The tuple type already proves the argument shape; runtime work is only the
 * array-position split used by generated path helpers.
 */
export function splitClientArgs<TInput, TOptions>(
  args: readonly unknown[],
): readonly [TInput | undefined, TOptions | undefined] {
  if (args.length > 2) {
    throw new ContractError(`Contract client helper expected at most 2 arguments but received ${args.length}.`);
  }
  return [args[0] as TInput | undefined, args[1] as TOptions | undefined];
}

/** Convert a typed client input object into the record shape required by contract route helpers. */
export function clientInputRecord<TInput>(input: TInput | undefined): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

/** Merge fixed path fields with the optional typed client input record. */
export function mergeClientInput<TInput>(
  fixed: Record<string, unknown>,
  input: TInput | undefined,
): Record<string, unknown> {
  return {
    ...fixed,
    ...(clientInputRecord(input) ?? {}),
  };
}

export interface JsonSchemaValidationFailure {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

export function firstJsonSchemaFailure(
  schema: Record<string, unknown>,
  value: unknown,
  path = '$',
  root: Record<string, unknown> = schema,
): JsonSchemaValidationFailure | undefined {
  if (typeof schema.$ref === 'string') {
    const resolved = resolveLocalSchemaRef(root, schema.$ref);
    return resolved ? firstJsonSchemaFailure(resolved, value, path, root) : undefined;
  }
  const allOf = readSchemaList(schema.allOf);
  for (const child of allOf) {
    const failure = firstJsonSchemaFailure(child, value, path, root);
    if (failure) return failure;
  }
  const anyOf = readSchemaList(schema.anyOf);
  if (anyOf.length > 0) {
    const failures = anyOf.map((child) => firstJsonSchemaFailure(child, value, path, root));
    if (failures.every(Boolean)) return bestSchemaFailure(failures) ?? { path, expected: 'one matching schema', received: typeOfJsonValue(value) };
  }
  const oneOf = readSchemaList(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((child) => !firstJsonSchemaFailure(child, value, path, root)).length;
    if (matches !== 1) return { path, expected: 'exactly one matching schema', received: `${matches} matches` };
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => Object.is(candidate, value))) {
    return { path, expected: `one of ${enumValues.map(String).join(', ')}`, received: typeOfJsonValue(value) };
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    return { path, expected: JSON.stringify(schema.const), received: typeOfJsonValue(value) };
  }
  const types = readSchemaTypes(schema.type);
  if (types.length > 0 && !types.some((type) => valueMatchesJsonType(value, type))) {
    return { path, expected: types.join(' | '), received: typeOfJsonValue(value) };
  }
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  if (typeof value === 'number' && minimum !== undefined && value < minimum) {
    return { path, expected: `>= ${minimum}`, received: String(value) };
  }
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  if (typeof value === 'number' && maximum !== undefined && value > maximum) {
    return { path, expected: `<= ${maximum}`, received: String(value) };
  }
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  if (typeof value === 'string' && minLength !== undefined && value.length < minLength) {
    return { path, expected: `length >= ${minLength}`, received: `length ${value.length}` };
  }
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  if (typeof value === 'string' && maxLength !== undefined && value.length > maxLength) {
    return { path, expected: `length <= ${maxLength}`, received: `length ${value.length}` };
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    const pattern = compileContractPattern(schema.pattern);
    if (!contractPatternMatches(pattern, value)) return { path, expected: `pattern ${schema.pattern}`, received: 'non-matching string' };
  }
  if (typeof value === 'string' && typeof schema.format === 'string' && !stringMatchesJsonSchemaFormat(value, schema.format)) {
    return { path, expected: `format ${schema.format}`, received: 'non-matching string' };
  }
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index++) {
        const failure = firstJsonSchemaFailure(itemSchema as Record<string, unknown>, value[index], `${path}[${index}]`, root);
        if (failure) return failure;
      }
    }
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    if (minItems !== undefined && value.length < minItems) return { path, expected: `items >= ${minItems}`, received: `${value.length} items` };
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (maxItems !== undefined && value.length > maxItems) return { path, expected: `items <= ${maxItems}`, received: `${value.length} items` };
    return undefined;
  }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) return { path: `${path}.${key}`, expected: 'required field', received: 'missing' };
    }
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
        if (!(key in objectValue)) continue;
        if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue;
        const failure = firstJsonSchemaFailure(propertySchema as Record<string, unknown>, objectValue[key], `${path}.${key}`, root);
        if (failure) return failure;
      }
    }
    if (schema.additionalProperties === false && properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const allowed = new Set(Object.keys(properties as Record<string, unknown>));
      const extra = Object.keys(objectValue).find((key) => !allowed.has(key));
      if (extra) return { path: `${path}.${extra}`, expected: 'no additional property', received: 'present' };
    }
  }
  return undefined;
}

function resolveLocalSchemaRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function bestSchemaFailure(failures: readonly (JsonSchemaValidationFailure | undefined)[]): JsonSchemaValidationFailure | undefined {
  return failures
    .filter((failure): failure is JsonSchemaValidationFailure => Boolean(failure))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function readSchemaList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function readSchemaTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function compileContractPattern(source: string): RegExp {
  if (source.length > MAX_SCHEMA_PATTERN_CHARS) {
    throw new ContractError(`Contract schema pattern exceeds ${MAX_SCHEMA_PATTERN_CHARS} characters.`);
  }
  for (const pattern of RISKY_SCHEMA_PATTERN_CHECKS) {
    if (pattern.test(source)) {
      throw new ContractError('Contract schema pattern is too expensive to evaluate safely.');
    }
  }
  return new RegExp(source);
}

function contractPatternMatches(pattern: RegExp, value: string): boolean {
  if (value.length > MAX_SCHEMA_PATTERN_INPUT_CHARS) {
    throw new ContractError(`Contract schema pattern input exceeds ${MAX_SCHEMA_PATTERN_INPUT_CHARS} characters.`);
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function valueMatchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function stringMatchesJsonSchemaFormat(value: string, format: string): boolean {
  switch (format) {
    case 'date-time':
      // JSON Schema date-time requires a full date/time separator; Date.parse
      // alone accepts date-only strings in some runtimes.
      return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
        && !Number.isNaN(Date.parse(value));
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
    case 'time':
      return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value);
    case 'duration':
      return /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value);
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'hostname':
      return isValidHostname(value);
    case 'ipv4':
      return isValidIpv4(value);
    case 'ipv6':
      return isValidIpv6(value);
    case 'uri':
    case 'url':
      return isValidUrl(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    default:
      return true;
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

function typeOfJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
