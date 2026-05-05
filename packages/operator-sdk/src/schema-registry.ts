import type { ZodType } from 'zod/v4';

function isZodSchema(value: unknown): value is ZodType {
  return Boolean(value && typeof value === 'object' && 'safeParse' in value && typeof (value as { readonly safeParse?: unknown }).safeParse === 'function');
}

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
