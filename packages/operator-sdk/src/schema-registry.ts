import type { ZodType } from 'zod/v4';

function isZodSchema(value: unknown): value is ZodType {
  return Boolean(value && typeof value === 'object' && 'safeParse' in value && typeof (value as { readonly safeParse?: unknown }).safeParse === 'function');
}

/**
 * Convert a contract method id (e.g. `'sessions.create'`) to the corresponding
 * Zod schema export name (e.g. `'SessionsCreateResponseSchema'`).
 *
 * Convention: dot-separated + underscore-separated segments are each
 * title-cased and concatenated, then `ResponseSchema` is appended.
 *
 * @param methodId - A dot-separated operator contract method id.
 * @returns The expected exported Zod schema identifier.
 */
export function methodIdToSchemaName(methodId: string): string {
  const pascal = methodId
    .split('.')
    .flatMap((segment) => segment.split('_'))
    .map((word) => {
      if (word.length === 0) {
        throw new Error(
          `Invalid contract method id "${methodId}": segments must not be empty (avoid consecutive or trailing underscores/dots).`,
        );
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
  return `${pascal}ResponseSchema`;
}

/**
 * Build a map from operator method id → Zod response schema by scanning the
 * exported symbols of the contracts package for names matching
 * `methodIdToSchemaName(methodId)`.
 *
 * Only entries where the exported value satisfies the `ZodType` interface
 * (has a `safeParse` method) are included. Unknown schema names are silently
 * skipped.
 *
 * @param methodIds - All operator contract method ids to map.
 * @param schemas - The module namespace object from `@pellux/goodvibes-contracts`.
 * @returns A partial record from method id to Zod schema.
 */
export function buildSchemaRegistry(
  methodIds: readonly string[],
  schemas: Record<string, unknown>,
): Partial<Record<string, ZodType>> {
  const candidateMap = new Map<string, string>();
  for (const methodId of methodIds) {
    candidateMap.set(methodIdToSchemaName(methodId), methodId);
  }
  const registry: Partial<Record<string, ZodType>> = {};
  for (const [key, value] of Object.entries(schemas)) {
    const methodId = candidateMap.get(key);
    if (methodId === undefined) continue;
    if (!isZodSchema(value)) continue;
    registry[methodId] = value;
  }
  return registry;
}
