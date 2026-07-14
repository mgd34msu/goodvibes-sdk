/**
 * ConfigKey union / ConfigValue mapping completeness — the drift-class gate.
 *
 * The published ConfigKey string-literal union and the ConfigValue<K> typed-
 * accessor mapping (platform/config/schema-types.ts) are hand-maintained,
 * while the actual key set is defined by the schema DOMAIN modules and
 * aggregated into CONFIG_SCHEMA (schema.ts). Because schema.ts casts the
 * aggregate (`as ConfigSetting[]`), a domain can add keys without the union or
 * mapping learning about them — the compiler never complains, and consumers
 * hit "not assignable to ConfigKey" and cast around it (the fleet.maxSize
 * find, 2026-07-14: 23 keys across checkin.*, learning.consolidation.*,
 * power.*, voice.local.*, fleet.maxSize had schema definitions but no union
 * entries).
 *
 * This test closes the class fail-closed, the same source-parse discipline as
 * scripts/check-foundation-io-types.ts: derive the authoritative key set from
 * CONFIG_SCHEMA at runtime, extract the union members and mapping clauses
 * from the committed schema-types.ts source, and fail on ANY difference in
 * either direction (a schema key missing from the union/mapping, or a stale
 * union/mapping entry no schema domain defines).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.js';

const SCHEMA_TYPES_PATH = join(
  import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'config', 'schema-types.ts',
);

/** Extract the ConfigKey union's string-literal members from source text. */
export function extractUnionMembers(source: string): Set<string> {
  const start = source.indexOf('export type ConfigKey =');
  if (start < 0) throw new Error('ConfigKey union not found in schema-types.ts');
  const end = source.indexOf(';', start);
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

/** Extract the keys the ConfigValue<K> mapping has `K extends '<key>'` clauses for. */
export function extractMappingKeys(source: string): Set<string> {
  const start = source.indexOf('export type ConfigValue<K extends ConfigKey>');
  if (start < 0) throw new Error('ConfigValue mapping not found in schema-types.ts');
  const end = source.indexOf('never;', start);
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/K extends '([^']+)'/g)].map((m) => m[1]!));
}

/**
 * The pure drift check: schema keys vs a declared set. Returns the misses in
 * both directions so the failure message names every drifted key.
 */
export function diffKeySets(schemaKeys: readonly string[], declared: ReadonlySet<string>): {
  missing: string[];
  stale: string[];
} {
  const schemaSet = new Set(schemaKeys);
  return {
    missing: schemaKeys.filter((k) => !declared.has(k)),
    stale: [...declared].filter((k) => !schemaSet.has(k)),
  };
}

describe('ConfigKey union completeness (fail-closed against the schema domains)', () => {
  const source = readFileSync(SCHEMA_TYPES_PATH, 'utf8');
  const schemaKeys = CONFIG_SCHEMA.map((setting) => setting.key as string);

  test('the schema defines a sane number of keys (extraction sanity floor)', () => {
    // If CONFIG_SCHEMA ever collapses (import/aggregation breakage), the two
    // completeness tests would vacuously pass on an empty set — fail loudly.
    expect(schemaKeys.length).toBeGreaterThan(300);
  });

  test('every schema-domain key is in the ConfigKey union, and no union member is stale', () => {
    const union = extractUnionMembers(source);
    const { missing, stale } = diffKeySets(schemaKeys, union);
    expect(missing, `ConfigKey union is missing schema-domain keys: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `ConfigKey union has members no schema domain defines: ${stale.join(', ')}`).toEqual([]);
  });

  test('every schema-domain key has a ConfigValue<K> mapping clause, and no clause is stale', () => {
    const mapping = extractMappingKeys(source);
    const { missing, stale } = diffKeySets(schemaKeys, mapping);
    expect(missing, `ConfigValue mapping is missing schema-domain keys: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `ConfigValue mapping has clauses no schema domain defines: ${stale.join(', ')}`).toEqual([]);
  });

  // Red-test the gate itself: seed a miss and prove the checker catches it in
  // both directions — the gate cannot silently rot into a vacuous pass.
  test('the checker CATCHES a seeded missing key', () => {
    const union = extractUnionMembers(source);
    const seeded = new Set(union);
    seeded.delete('fleet.maxSize');
    const { missing } = diffKeySets(schemaKeys, seeded);
    expect(missing).toEqual(['fleet.maxSize']);
  });

  test('the checker CATCHES a seeded stale member', () => {
    const union = extractUnionMembers(source);
    const seeded = new Set(union);
    seeded.add('phantom.key.no.domain.defines');
    const { stale } = diffKeySets(schemaKeys, seeded);
    expect(stale).toEqual(['phantom.key.no.domain.defines']);
  });

  test('the source extractors actually parse the committed file (non-empty, disjoint anchors)', () => {
    const union = extractUnionMembers(source);
    const mapping = extractMappingKeys(source);
    expect(union.size).toBeGreaterThan(300);
    expect(mapping.size).toBeGreaterThan(300);
    // The consumer-found key resolves through both, typed end to end.
    expect(union.has('fleet.maxSize')).toBe(true);
    expect(mapping.has('fleet.maxSize')).toBe(true);
  });
});
