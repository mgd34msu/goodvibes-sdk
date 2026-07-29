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

/**
 * Every source file that declares part of the union or the mapping.
 *
 * schema-types.ts was split (schema-types-values.ts took the ConfigValue map,
 * schema-types-owner-profile.ts took the `profile.*` key union and its own
 * value map, which schema-types.ts folds in with one arm each). Reading only
 * the original file would have made this gate silently stop covering whichever
 * domain moved — which is the fail-open it exists to prevent, so the list is
 * explicit and the anchors below match a FAMILY of declarations rather than
 * one fixed name.
 */
const CONFIG_DIR = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'config');

/**
 * Discovered, not listed.
 *
 * An explicit list is a second place to remember: a domain that splits into a
 * new `schema-types-<domain>.ts` and is not added here becomes invisible to
 * this gate, which is the same fail-open the file exists to prevent, just one
 * level up. Matching every `schema-types*.ts` in the directory means a new
 * split file is covered the moment it exists.
 */
function schemaTypeSources(): string[] {
  return readdirSync(CONFIG_DIR)
    .filter((name) => /^schema-types.*\.ts$/.test(name))
    .sort()
    .map((name) => join(CONFIG_DIR, name));
}

const SCHEMA_TYPE_SOURCES = schemaTypeSources();

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
 * Every `export type <Something>ConfigKey =` declaration, so a domain that
 * carries its own key union — schema-types-owner-profile.ts,
 * schema-types-payments.ts, schema-types-daemon.ts — is covered by the same
 * parse rather than being invisible to it.
 */
const KEY_UNION_ANCHOR = /export type \w*ConfigKey =/g;

/** Every `export type <Something>ConfigValue<K extends <Something>ConfigKey> =`. */
const VALUE_MAP_ANCHOR = /export type \w*ConfigValue<K extends \w*ConfigKey> =/g;

/**
 * Every `export interface <Something>ConfigValueMap {`.
 *
 * The two domain shapes in this codebase state their value types differently
 * and BOTH have to be followed:
 *
 *   - owner-profile declares a conditional type
 *     (`ProfileConfigValue<K extends ProfileConfigKey>`), matched by
 *     VALUE_MAP_ANCHOR above, whose arms are literal `K extends '<key>'`.
 *   - payments and daemon-process declare an INTERFACE whose property names
 *     are the keys, folded into ConfigValue by a single
 *     `K extends keyof PaymentsConfigValueMap ? PaymentsConfigValueMap[K] :`
 *     arm.
 *
 * Reading only the arm sees one clause where the map declares dozens of keys,
 * so every key in those domains would read as unmapped. The map is therefore
 * read directly, which also means the check never depends on the arm's exact
 * spelling.
 */
const VALUE_INTERFACE_ANCHOR = /export interface \w*ConfigValueMap \{/g;

/** The bodies of every declaration matching `anchor`, each ending at `terminator`. */
function declarationBodies(source: string, anchor: RegExp, terminator: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(anchor)) {
    const start = match.index;
    const end = source.indexOf(terminator, start);
    if (end < 0) throw new Error(`declaration starting at ${start} has no "${terminator}" terminator`);
    bodies.push(withoutComments(source.slice(start, end)));
  }
  return bodies;
}

/** Extract the ConfigKey union's string-literal members from source text. */
export function extractUnionMembers(source: string): Set<string> {
  const bodies = declarationBodies(source, KEY_UNION_ANCHOR, ';');
  if (bodies.length === 0) throw new Error('no ConfigKey union found in the schema type sources');
  const members = new Set<string>();
  for (const body of bodies) {
    for (const match of body.matchAll(/'([^']+)'/g)) members.add(match[1]!);
  }
  return members;
}

/** Extract the keys ConfigValue<K> resolves, in both of the shapes above. */
export function extractMappingKeys(source: string): Set<string> {
  const conditional = declarationBodies(source, VALUE_MAP_ANCHOR, 'never;');
  const interfaces = declarationBodies(source, VALUE_INTERFACE_ANCHOR, '\n}');
  if (conditional.length === 0 && interfaces.length === 0) {
    throw new Error('no ConfigValue mapping found in the schema type sources');
  }
  const keys = new Set<string>();
  for (const body of conditional) {
    for (const match of body.matchAll(/K extends '([^']+)'/g)) keys.add(match[1]!);
  }
  for (const body of interfaces) {
    for (const match of body.matchAll(/'([^']+)'\s*:/g)) keys.add(match[1]!);
  }
  return keys;
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
  const source = SCHEMA_TYPE_SOURCES.map((path) => readFileSync(path, 'utf8')).join('\n');
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

  test('the source extractors actually parse the committed files (non-empty, disjoint anchors)', () => {
    const union = extractUnionMembers(source);
    const mapping = extractMappingKeys(source);
    expect(union.size).toBeGreaterThan(300);
    expect(mapping.size).toBeGreaterThan(300);
    // The consumer-found key resolves through both, typed end to end.
    expect(union.has('fleet.maxSize')).toBe(true);
    expect(mapping.has('fleet.maxSize')).toBe(true);
  });
});
