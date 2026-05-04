/**
 * arbitraries.unit.test.ts — drift guard for the shared arbitraries module.
 *
 * Verifies that:
 *   1. Every entry in FIXTURE_EVENTS has the required fields defined in
 *      REQUIRED_FIELDS_BY_TYPE for its event type.
 *   2. FIXTURE_EVENTS covers every KNOWN_EVENT_TYPES entry at least once.
 *   3. jsonValueArb generates values that survive a JSON round-trip.
 *
 * This test exists so that when new event types are added to the SDK the
 * author is reminded to update both KNOWN_EVENT_TYPES and FIXTURE_EVENTS.
 */

import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  jsonValueArb,
  KNOWN_EVENT_TYPES,
  REQUIRED_FIELDS_BY_TYPE,
  FIXTURE_EVENTS,
} from './arbitraries.js';

// ---------------------------------------------------------------------------
// 1. Required-field coverage: every FIXTURE_EVENTS entry satisfies its schema
// ---------------------------------------------------------------------------

describe('FIXTURE_EVENTS — required-field drift guard', () => {
  test('every fixture event contains all REQUIRED_FIELDS_BY_TYPE for its type', () => {
    const violations: string[] = [];

    for (const event of FIXTURE_EVENTS) {
      const required = REQUIRED_FIELDS_BY_TYPE[event.type];
      if (!required) continue; // no required-field spec — skip

      for (const field of required) {
        if (!(field in event)) {
          violations.push(`${event.type}: missing required field '${field}'`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `arbitraries drift: fixture events are missing required fields:\n${violations.map((v) => `  ${v}`).join('\n')}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Coverage: every KNOWN_EVENT_TYPES entry appears in FIXTURE_EVENTS
// ---------------------------------------------------------------------------

describe('FIXTURE_EVENTS — known-type coverage drift guard', () => {
  test('every KNOWN_EVENT_TYPES entry has at least one entry in FIXTURE_EVENTS', () => {
    const coveredTypes = new Set(FIXTURE_EVENTS.map((e) => e.type));
    const missing: string[] = [];

    for (const eventType of KNOWN_EVENT_TYPES) {
      if (!coveredTypes.has(eventType)) {
        missing.push(eventType);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `arbitraries drift: the following KNOWN_EVENT_TYPES have no fixture in FIXTURE_EVENTS:\n${missing.map((t) => `  ${t}`).join('\n')}`,
      );
    }

    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. jsonValueArb — basic soundness
// ---------------------------------------------------------------------------

describe('jsonValueArb — basic soundness', () => {
  test('generated values are JSON-representable (no undefined, no functions)', () => {
    fc.assert(
      fc.property(jsonValueArb, (value) => {
        // JSON.stringify must not throw — values like undefined or functions are not JSON-safe
        expect(() => JSON.stringify(value)).not.toThrow();
      }),
      { numRuns: 50 },
    );
  });

  test('generated non-Infinity values survive JSON round-trip', () => {
    // Note: fc.double({ noNaN: true }) can still produce Infinity/-Infinity which
    // JSON.stringify converts to null (not Infinity). We use fc.pre to skip those
    // cases by checking that the value has no non-finite numbers.
    function hasInfinity(v: unknown): boolean {
      if (typeof v === 'number') return !Number.isFinite(v);
      if (Array.isArray(v)) return v.some(hasInfinity);
      if (v !== null && typeof v === 'object') return Object.values(v as object).some(hasInfinity);
      return false;
    }
    fc.assert(
      fc.property(jsonValueArb, (value) => {
        fc.pre(!hasInfinity(value));
        const serialized = JSON.stringify(value);
        const parsed = JSON.parse(serialized) as unknown;
        expect(parsed).toEqual(value);
      }),
      { numRuns: 50 },
    );
  });
});
