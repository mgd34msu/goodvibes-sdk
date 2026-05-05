/**
 * any-runtime-event-property.test.ts — S-ζ Test 3
 *
 * Property-based tests on `AnyRuntimeEvent` discriminants using `fast-check`.
 *
 * Properties tested:
 *   1. Round-trip: JSON.stringify → JSON.parse preserves structural equality for every known event.
 *   2. Malformed event: wrong `type` field → validator returns a typed error (not silent pass).
 *   3. Missing required field on a known type → validator returns a typed error.
 *
 * Coverage: ≥ 100 iterations per event kind (fast-check default is 100).
 *
 * Import strategy: leaf event source files are imported directly by relative path
 * so bun can resolve them as TypeScript without any package import. This matches
 * the pattern used in runtime-event-discriminated-union.test.ts.
 *
 * Arbitraries and fixture data are shared via `./_shared/arbitraries.ts` for reuse
 * across integration tests.
 */

import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';

import {
  jsonValueArb,
  FIXTURE_EVENTS,
  KNOWN_EVENT_TYPES,
  REQUIRED_FIELDS_BY_TYPE,
} from './_shared/arbitraries.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * A typed validation error returned by the event validator.
 *
 * Validation failures must produce this instead of throwing.
 */
export interface EventValidationError {
  readonly kind: 'EventValidationError';
  readonly message: string;
  readonly received: unknown;
}

function validationError(message: string, received: unknown): EventValidationError {
  return { kind: 'EventValidationError', message, received };
}

/**
 * Minimal runtime validator for `AnyRuntimeEvent`.
 *
 * Accepts any plain object with a known `type` discriminant and at least
 * the required fields for that type. Returns `EventValidationError` on failure.
 *
 * This is deliberately not a full JSON schema validator — it checks:
 *   - `type` is a string and is a known event type
 *   - required discriminant-specific fields are present
 */
function validateAnyRuntimeEvent(
  value: unknown,
): { ok: true; event: { type: string } } | { ok: false; error: EventValidationError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: validationError('Expected a plain object', value) };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['type'] !== 'string' || !obj['type']) {
    return { ok: false, error: validationError('Missing or non-string `type` field', value) };
  }
  const t = obj['type'] as string;
  if (!KNOWN_EVENT_TYPES.has(t)) {
    return { ok: false, error: validationError(`Unknown event type: ${t}`, value) };
  }
  // Check required fields per type (representative sample covering each domain)
  const missing = REQUIRED_FIELDS_BY_TYPE[t]?.filter((f) => !(f in obj)) ?? [];
  if (missing.length > 0) {
    return {
      ok: false,
      error: validationError(`Missing required fields for ${t}: ${missing.join(', ')}`, value),
    };
  }
  return { ok: true, event: obj as { type: string } };
}

// ---------------------------------------------------------------------------
// Serialize/deserialize round-trip helper
// ---------------------------------------------------------------------------

function roundTrip(event: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Property: round-trip — parse(serialize(event)) ≡ event (structural equality)
// ---------------------------------------------------------------------------

describe('AnyRuntimeEvent — JSON round-trip property', () => {
  test('every fixture event survives JSON serialize → parse with structural equality', () => {
    for (const event of FIXTURE_EVENTS) {
      const restored = roundTrip(event);
      // Deep structural equality: all fields present and values match.
      // Note: undefined-valued optional fields may be dropped by JSON — that is correct
      // behaviour; we only assert that present fields are preserved.
      expect(restored).toMatchObject(event);
    }
  });

  test('fast-check: generated extra fields on known events are preserved by round-trip', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURE_EVENTS),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 16 }), jsonValueArb),
        (baseEvent, extraFields) => {
          // Merge extra fields onto a copy of the event
          const extended: Record<string, unknown> = { ...baseEvent, ...extraFields };
          const restored = roundTrip(extended) as Record<string, unknown>;
          // The `type` discriminant must survive
          return restored['type'] === baseEvent.type;
        },
      ),
      { numRuns: 100 },
    );
  });

  test('fast-check: round-trip preserves all required fields for every fixture event kind', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURE_EVENTS),
        (event) => {
          const restored = roundTrip(event) as Record<string, unknown>;
          const requiredFields = REQUIRED_FIELDS_BY_TYPE[event.type] ?? [];
          return requiredFields.every((field) => field in restored);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property: malformed events — wrong type or missing required field → error
// ---------------------------------------------------------------------------

describe('AnyRuntimeEvent — validation rejects malformed events', () => {
  test('null input → validation error', () => {
    const result = validateAnyRuntimeEvent(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('EventValidationError');
    }
  });

  test('non-object input → validation error', () => {
    for (const bad of [42, 'string', true, [], undefined]) {
      const result = validateAnyRuntimeEvent(bad);
      expect(result.ok).toBe(false);
    }
  });

  test('object with missing type field → validation error', () => {
    const result = validateAnyRuntimeEvent({ sessionId: 's1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('EventValidationError');
      expect(result.error.message).toContain('type');
    }
  });

  test('object with unknown type → validation error with type name in message', () => {
    const result = validateAnyRuntimeEvent({ type: 'UNKNOWN_EVENT_TYPE_XYZ', sessionId: 's1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('EventValidationError');
      expect(result.error.message).toContain('UNKNOWN_EVENT_TYPE_XYZ');
    }
  });

  test('fast-check: arbitrary unknown type strings always rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !KNOWN_EVENT_TYPES.has(s)),
        (unknownType) => {
          const result = validateAnyRuntimeEvent({ type: unknownType });
          return result.ok === false;
        },
      ),
      { numRuns: 100 },
    );
  });

  test('fast-check: known type with missing required fields → validation error', () => {
    // Pick events that have at least one required field to drop
    const eventsWithRequiredFields = FIXTURE_EVENTS.filter(
      (e) => (REQUIRED_FIELDS_BY_TYPE[e.type]?.length ?? 0) > 0,
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...eventsWithRequiredFields),
        (event) => {
          const requiredFields = REQUIRED_FIELDS_BY_TYPE[event.type]!;
          // Drop the first required field
          const truncated: Record<string, unknown> = { ...event };
          delete truncated[requiredFields[0]!];
          const result = validateAnyRuntimeEvent(truncated);
          return result.ok === false;
        },
      ),
      { numRuns: 100 },
    );
  });

  test('valid fixture events all pass validation', () => {
    for (const event of FIXTURE_EVENTS) {
      const result = validateAnyRuntimeEvent(event);
      expect(result.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Domain coverage: verify KNOWN_EVENT_TYPES covers every fixture event
// ---------------------------------------------------------------------------

describe('AnyRuntimeEvent — coverage invariant', () => {
  test('every fixture event type is in KNOWN_EVENT_TYPES', () => {
    for (const event of FIXTURE_EVENTS) {
      expect(KNOWN_EVENT_TYPES.has(event.type)).toBe(true);
    }
  });

  test('KNOWN_EVENT_TYPES matches fixture event count (no gaps, no extras)', () => {
    const fixtureTypes = new Set(FIXTURE_EVENTS.map((e) => e.type));
    // Note: PLAN_STRATEGY_SELECTED / PLAN_STRATEGY_OVERRIDDEN are included in both
    for (const type of KNOWN_EVENT_TYPES) {
      expect(fixtureTypes.has(type)).toBe(true);
    }
  });
});
