/**
 * Two declarations that asked for more than they use.
 *
 * Neither is a crash. Both are contracts wider than the code behind them, which
 * is the shape that makes a caller write a value it does not have and a reader
 * believe a dependency that is not real. They were visible only once `test/`
 * started being compiled.
 *
 * The assertions are type-level, evaluated by `bun run typecheck`; the runtime
 * cases below them exercise the same call shapes so the file is not purely
 * declarative. Each pair includes an input that must resolve to `'no'`, so a
 * widening that made everything assignable would fail here rather than pass.
 */
import { describe, expect, test } from 'bun:test';

import { gateBackgroundToolCall } from '../packages/sdk/src/platform/agents/background-permission-gate.js';
import type { PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';

type AgentRecordArg = Parameters<typeof gateBackgroundToolCall>[1];
type Accepts<T> = T extends AgentRecordArg ? 'yes' : 'no';

/**
 * `gateBackgroundToolCall` required `template` and its body treats it as
 * optional (`record.template ? { template: record.template } : {}`), because
 * `PermissionAttribution.template` is itself optional. The requirement was
 * inherited from `Pick<AgentRecord, 'id' | 'template'>`, not from anything the
 * function does.
 */
export const acceptsFullRecord: Accepts<{ id: string; template: string }> = 'yes';
export const acceptsRecordWithoutTemplate: Accepts<{ id: string }> = 'yes';
export const acceptsUndefinedTemplate: Accepts<{ id: string; template: undefined }> = 'yes';
/** The proof this can still answer no: `id` is genuinely required. */
export const rejectsRecordWithoutId: Accepts<{ template: string }> = 'no';

type Snapshot = ReturnType<PermissionConfigReader['getSnapshot']>;
type Reads<K extends string> = K extends keyof Snapshot ? 'yes' : 'no';

/**
 * `getSnapshot()` returned the ENTIRE `GoodVibesConfig`. Its two consumers, both
 * in permissions/manager.ts, read `.permissions` and nothing else, so the
 * declaration claimed a dependency on every config domain in the product.
 */
export const snapshotExposesPermissions: Reads<'permissions'> = 'yes';
/** The proof this can still answer no: the rest of the config is not in scope. */
export const snapshotHidesDisplay: Reads<'display'> = 'no';
export const snapshotHidesProvider: Reads<'provider'> = 'no';

describe('gateBackgroundToolCall', () => {
  test('a record with no template is accepted and produces no template attribution', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const manager = {
      getBackgroundAgentsMode: () => 'inherit' as const,
      check: async () => true,
      checkDetailed: async (_tool: string, _args: Record<string, unknown>, attribution?: unknown) => {
        seen.push(attribution as Record<string, unknown> | undefined);
        return { approved: true as const };
      },
    };
    const outcome = await gateBackgroundToolCall(
      { permissionManager: manager as unknown as Parameters<typeof gateBackgroundToolCall>[0]['permissionManager'] },
      { id: 'agent-1' },
      'read',
      { path: 'a.ts' },
    );
    expect(outcome.approved).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'background-agent', agentId: 'agent-1' });
    expect(Object.prototype.hasOwnProperty.call(seen[0] ?? {}, 'template')).toBe(false);
  });

  test('a record WITH a template still carries it through', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const manager = {
      getBackgroundAgentsMode: () => 'inherit' as const,
      check: async () => true,
      checkDetailed: async (_tool: string, _args: Record<string, unknown>, attribution?: unknown) => {
        seen.push(attribution as Record<string, unknown> | undefined);
        return { approved: true as const };
      },
    };
    await gateBackgroundToolCall(
      { permissionManager: manager as unknown as Parameters<typeof gateBackgroundToolCall>[0]['permissionManager'] },
      { id: 'agent-2', template: 'engineer' },
      'read',
      { path: 'a.ts' },
    );
    expect(seen[0]).toMatchObject({ template: 'engineer' });
  });
});

describe('PermissionConfigReader', () => {
  test('a reader supplying only the permissions slice satisfies the contract', () => {
    // Before narrowing, a caller had to produce an entire GoodVibesConfig to
    // stand in for a reader whose consumers touch one key.
    const reader: Pick<PermissionConfigReader, 'getSnapshot'> = {
      getSnapshot: () => ({ permissions: {} as Snapshot['permissions'] }),
    };
    expect(reader.getSnapshot().permissions).toBeDefined();
  });
});
