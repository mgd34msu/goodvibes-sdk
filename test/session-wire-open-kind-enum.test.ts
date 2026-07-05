import { describe, expect, test } from 'bun:test';
import { firstJsonSchemaFailure } from '../packages/transport-http/src/index.js';
import {
  SESSION_BROKER_SNAPSHOT_SCHEMA,
  SHARED_SESSION_RECORD_SCHEMA,
  SHARED_SESSION_REGISTER_INPUT_SCHEMA,
} from '../packages/sdk/src/platform/control-plane/operator-contract-schemas-runtime.ts';

// D1 — CONTRACT-VALIDATION ENUM LEG. Response validation must treat the session
// `kind` as an OPEN enum on READ (accept unknown strings per-record so one alien
// record can never blank a sessions.list envelope), while INPUT/write validation
// stays strict (sessions.register 400s on an unknown kind).

function recordWithKind(kind: string): Record<string, unknown> {
  return {
    id: 'user-abc',
    kind,
    project: '/proj',
    title: 'Session user-abc',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
  };
}

describe('session wire — kind enum is open on read', () => {
  test('a record carrying an unknown kind passes RECORD response validation', () => {
    // 'quantum' is not one of the six modeled kinds; a future/mixed-version daemon
    // could emit a kind this build does not know.
    expect(firstJsonSchemaFailure(SHARED_SESSION_RECORD_SCHEMA, recordWithKind('quantum'))).toBeUndefined();
  });

  test('known kinds still validate on read', () => {
    for (const kind of ['tui', 'agent', 'webui', 'companion-task', 'companion-chat', 'automation']) {
      expect(firstJsonSchemaFailure(SHARED_SESSION_RECORD_SCHEMA, recordWithKind(kind))).toBeUndefined();
    }
  });

  test('a sessions.list envelope with one unknown-kind record validates whole (no blanking)', () => {
    const envelope = {
      totals: { sessions: 2, active: 2, closed: 0 },
      sessions: [recordWithKind('agent'), recordWithKind('some-future-kind')],
    };
    // Before the fix this threw at $.sessions[1].kind and blanked the entire list.
    expect(firstJsonSchemaFailure(SESSION_BROKER_SNAPSHOT_SCHEMA, envelope)).toBeUndefined();
  });

  test('a non-string kind is still rejected on read (open enum, not "anything")', () => {
    const failure = firstJsonSchemaFailure(SHARED_SESSION_RECORD_SCHEMA, { ...recordWithKind('tui'), kind: 42 });
    expect(failure).toBeDefined();
    expect(failure?.path).toBe('$.kind');
  });
});

describe('session wire — register INPUT kind stays strict', () => {
  const validInput = {
    sessionId: 'user-abc',
    participant: { surfaceKind: 'tui', surfaceId: 'surface:tui', lastSeenAt: 1 },
  };

  test('a known kind passes input validation', () => {
    expect(firstJsonSchemaFailure(SHARED_SESSION_REGISTER_INPUT_SCHEMA, { ...validInput, kind: 'agent' })).toBeUndefined();
  });

  test('an unknown kind FAILS input validation (write path is strict)', () => {
    const failure = firstJsonSchemaFailure(SHARED_SESSION_REGISTER_INPUT_SCHEMA, { ...validInput, kind: 'some-future-kind' });
    expect(failure).toBeDefined();
    expect(failure?.path).toBe('$.kind');
  });
});
