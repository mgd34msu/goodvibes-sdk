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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA } from '../packages/sdk/src/platform/config/schema.js';

const SCHEMA_TYPES_PATH = join(
  import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'config', 'schema-types.ts',
);

/**
 * Comments are stripped before any quote matching.
 *
 * Both extractors below pair single quotes across a whole declaration, so ONE
 * apostrophe in a prose comment inside the union ("the daemon's own mailbox")
 * re-pairs every quote after it and silently truncates the extracted set — the
 * gate keeps passing while it has stopped covering the tail of the union. That
 * is exactly the fail-open this file exists to prevent, so the comment text is
 * removed rather than trusted to stay apostrophe-free.
 */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The sibling `schema-types-*.ts` files, concatenated.
 *
 * `ConfigKey` and `ConfigValue` are partly COMPOSED rather than wholly
 * literal: a domain whose keys would push schema-types.ts past its
 * grandfathered line ceiling declares them as a named union plus a value map
 * in its own split file (`PaymentsConfigKey`, `DaemonProcessConfigKey`), and
 * schema-types.ts references the name. A purely textual scan of schema-types.ts
 * would therefore see zero keys for those domains and report them missing —
 * the gate failing on the file LAYOUT rather than on drift, which is not what
 * it is for. Resolving the references keeps the check on completeness, where
 * it belongs, and it still fails closed: an unresolvable reference contributes
 * nothing and the domain's keys read as missing.
 */
function splitTypeSources(): string {
  const dir = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'config');
  return readdirSync(dir)
    .filter((name) => /^schema-types-.*\.ts$/.test(name))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

/** The string-literal members of a named union declared in a split file. */
function membersOfNamedUnion(name: string, sources: string): string[] {
  const start = sources.indexOf(`export type ${name} =`);
  if (start < 0) return [];
  const end = sources.indexOf(';', start);
  return [...withoutComments(sources.slice(start, end)).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** The property keys of a named interface declared in a split file. */
function keysOfNamedMap(name: string, sources: string): string[] {
  const start = sources.indexOf(`export interface ${name} {`);
  if (start < 0) return [];
  const end = sources.indexOf('\n}', start);
  return [...withoutComments(sources.slice(start, end)).matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]!);
}

/** Extract the ConfigKey union's members, following composed named unions. */
export function extractUnionMembers(source: string, splitSources = splitTypeSources()): Set<string> {
  const start = source.indexOf('export type ConfigKey =');
  if (start < 0) throw new Error('ConfigKey union not found in schema-types.ts');
  const end = source.indexOf(';', start);
  const body = withoutComments(source.slice(start, end));
  const literals = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const referenced = [...body.matchAll(/\|\s*(\w+ConfigKey)\b/g)].map((m) => m[1]!);
  const composed = referenced.flatMap((name) => membersOfNamedUnion(name, splitSources));
  return new Set([...literals, ...composed]);
}

/**
 * Extract the keys ConfigValue<K> resolves, following composed value maps.
 *
 * Two shapes count: a literal `K extends '<key>' ?` clause, and a
 * `K extends keyof SomeConfigValueMap ? SomeConfigValueMap[K] :` clause whose
 * map is declared in a split file. See splitTypeSources for why both exist.
 */
export function extractMappingKeys(source: string, splitSources = splitTypeSources()): Set<string> {
  const start = source.indexOf('export type ConfigValue<K extends ConfigKey>');
  if (start < 0) throw new Error('ConfigValue mapping not found in schema-types.ts');
  const end = source.indexOf('never;', start);
  const body = withoutComments(source.slice(start, end));
  const literals = [...body.matchAll(/K extends '([^']+)'/g)].map((m) => m[1]!);
  const referenced = [...body.matchAll(/K extends keyof (\w+ConfigValueMap)\b/g)].map((m) => m[1]!);
  const composed = referenced.flatMap((name) => keysOfNamedMap(name, splitSources));
  return new Set([...literals, ...composed]);
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

  // The truncation this guards against is not hypothetical: adding the daemon
  // mailbox keys with a `// the daemon's own mailbox` comment above them cut the
  // extracted union from 300-odd members to 259, because the apostrophe
  // re-paired every quote after it. The sanity floor below caught it, but only
  // because the loss was large — a comment nearer the end of the union would
  // have dropped a handful of keys and still cleared the floor.
  test('an apostrophe in a comment inside the union cannot truncate the extracted set', () => {
    const withApostrophe = [
      "export type ConfigKey =",
      "  | 'alpha.one'",
      "  // the daemon's own mailbox and calendar",
      "  | 'beta.two'",
      "  | 'gamma.three';",
    ].join('\n');
    expect([...extractUnionMembers(withApostrophe)]).toEqual(['alpha.one', 'beta.two', 'gamma.three']);
  });

  test('an apostrophe in a comment inside the mapping cannot truncate it either', () => {
    const withApostrophe = [
      "export type ConfigValue<K extends ConfigKey> =",
      "  K extends 'alpha.one' ? string :",
      "  // the daemon's own mailbox",
      "  K extends 'beta.two' ? number :",
      "  never;",
    ].join('\n');
    expect([...extractMappingKeys(withApostrophe)]).toEqual(['alpha.one', 'beta.two']);
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
