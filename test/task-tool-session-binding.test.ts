/**
 * task-tool-session-binding.test.ts, the task tool's owning `sessionId` comes
 * from real runtime identity, not from the model's tool input.
 *
 * The defect this covers: `createTaskTool(registry)` bound no identity at all.
 * The owning session on every ref came from `input.sessionId`, a free-form
 * string in the tool schema that the model could set to anything and almost
 * always omitted, in which case it fell back to the literal `'local'`. So the
 * cross-session task registry, whose entire purpose is keying work by session,
 * kept nearly everything in one shared bucket under a name no session register
 * could ever resolve.
 *
 * That is what made owner-existence reaping impossible to write honestly: any
 * predicate asked "does session 'local' exist?" must answer no, and reaping on
 * that answer would have deleted the whole graph on the first sweep. The fix is
 * upstream, bind the key to identity, and these tests pin it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskTool } from '../packages/sdk/src/platform/tools/task/index.js';
import { CrossSessionTaskRegistry } from '../packages/sdk/src/platform/sessions/orchestration/index.js';
import { LEGACY_TASK_NAMESPACE } from '../packages/sdk/src/platform/sessions/orchestration/types.js';

function makeRegistry(): CrossSessionTaskRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'gv-task-binding-'));
  return new CrossSessionTaskRegistry(join(dir, 'task-graph.json'), { sweepIntervalMs: 0 });
}

/** Run one task-tool call and parse its JSON output. */
async function call(
  tool: ReturnType<typeof createTaskTool>,
  args: Record<string, unknown>,
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const result = await tool.execute(args);
  return {
    success: result.success,
    ...(typeof result.output === 'string' ? { output: JSON.parse(result.output) as unknown } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

describe('writes are owned by the real session, never by the tool input', () => {
  test('create ignores a model-supplied sessionId and uses the runtime identity', async () => {
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry, { resolveSessionId: () => 'real-session-1' });
      const created = await call(tool, {
        mode: 'create',
        taskId: 't1',
        title: 'Ship it',
        // The spoof: the model naming a session that is not its own.
        sessionId: 'someone-elses-session',
      });
      expect(created.success).toBe(true);

      // The ref landed under the REAL identity...
      expect(registry.getRef('real-session-1', 't1')).not.toBeNull();
      // ...and nothing at all was written under the name the model supplied.
      expect(registry.getRef('someone-elses-session', 't1')).toBeUndefined();
      expect(registry.getRefsBySession('someone-elses-session')).toEqual([]);
    } finally {
      registry.dispose();
    }
  });

  test('status, cancel and handoff all key on the real identity too', async () => {
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry, { resolveSessionId: () => 'real-session-2' });
      await call(tool, { mode: 'create', taskId: 't1', title: 'Task' });

      // status: a spoofed sessionId must not be able to reach another session's ref.
      const status = await call(tool, { mode: 'status', taskId: 't1', status: 'completed', sessionId: 'spoof' });
      expect(status.success).toBe(true);
      expect(registry.getRef('real-session-2', 't1')?.status).toBe('completed');

      // handoff: the FROM side is always us; the TO side is a legitimate counterparty.
      const handoff = await call(tool, {
        mode: 'handoff',
        taskId: 't1',
        toSessionId: 'peer-session',
        sessionId: 'spoof',
      });
      expect(handoff.success).toBe(true);
      const records = registry.getHandoffs();
      expect(records).toHaveLength(1);
      expect(records[0]?.fromSessionId).toBe('real-session-2');
      expect(records[0]?.toSessionId).toBe('peer-session');

      const cancelled = await call(tool, { mode: 'cancel', taskId: 't1', sessionId: 'spoof' });
      expect(cancelled.success).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  test('the identity is re-read per call — a session id that changes mid-run is followed', async () => {
    // Accepting a crash-recovery snapshot reassigns runtime.sessionId in place.
    // An id captured at registration time would keep writing refs under the boot
    // session the user just left behind.
    const registry = makeRegistry();
    try {
      let current = 'boot-session';
      const tool = createTaskTool(registry, { resolveSessionId: () => current });

      await call(tool, { mode: 'create', taskId: 'before', title: 'Before recovery' });
      current = 'recovered-session';
      await call(tool, { mode: 'create', taskId: 'after', title: 'After recovery' });

      expect(registry.getRefsBySession('boot-session').map((r) => r.taskId)).toEqual(['before']);
      expect(registry.getRefsBySession('recovered-session').map((r) => r.taskId)).toEqual(['after']);
    } finally {
      registry.dispose();
    }
  });
});

describe('reads may still name another session — reading is not owning', () => {
  test('list and show accept a sessionId selector', async () => {
    const registry = makeRegistry();
    try {
      const mine = createTaskTool(registry, { resolveSessionId: () => 'me' });
      const theirs = createTaskTool(registry, { resolveSessionId: () => 'them' });
      await call(mine, { mode: 'create', taskId: 'a', title: 'Mine' });
      await call(theirs, { mode: 'create', taskId: 'b', title: 'Theirs' });

      // Cross-session inspection is the point of a cross-session registry.
      const listed = await call(mine, { mode: 'list', sessionId: 'them' });
      const payload = listed.output as { sessionId: string; count: number };
      expect(payload.sessionId).toBe('them');
      expect(payload.count).toBe(1);

      const shown = await call(mine, { mode: 'show', taskId: 'b', sessionId: 'them' });
      expect(shown.success).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  test('list defaults to the caller\'s own session when no selector is given', async () => {
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry, { resolveSessionId: () => 'only-mine' });
      await call(tool, { mode: 'create', taskId: 'a', title: 'A' });
      const listed = await call(tool, { mode: 'list' });
      expect((listed.output as { sessionId: string }).sessionId).toBe('only-mine');
    } finally {
      registry.dispose();
    }
  });
});

describe('an unbound host falls back to the legacy namespace, visibly', () => {
  test('without resolveSessionId every ref lands in the legacy namespace', async () => {
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry);
      await call(tool, { mode: 'create', taskId: 't1', title: 'Unbound' });
      expect(registry.getRef(LEGACY_TASK_NAMESPACE, 't1')).not.toBeNull();
    } finally {
      registry.dispose();
    }
  });

  test('an unbound host still cannot be spoofed into another namespace', async () => {
    // The fallback is the legacy bucket, NOT whatever the model asked for,
    // otherwise removing the binding would silently restore the old defect.
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry);
      await call(tool, { mode: 'create', taskId: 't1', title: 'Unbound', sessionId: 'spoof' });
      expect(registry.getRef('spoof', 't1')).toBeUndefined();
      expect(registry.getRef(LEGACY_TASK_NAMESPACE, 't1')).not.toBeNull();
    } finally {
      registry.dispose();
    }
  });
});

describe('the wired predicate reaches the registry', () => {
  test('a live-but-unsaved session\'s refs survive a sweep', async () => {
    // The session exists in the broker but has never been written to the
    // session store. Owner-existence must be answered by the register that
    // knows about live sessions, not by what happens to be on disk.
    const registry = makeRegistry();
    try {
      const tool = createTaskTool(registry, { resolveSessionId: () => 'live-unsaved' });
      await call(tool, { mode: 'create', taskId: 't1', title: 'In flight' });
      expect(registry.reap().refsMissingSession).toBe(0);
      expect(registry.getRef('live-unsaved', 't1')).not.toBeNull();
    } finally {
      registry.dispose();
    }
  });

  test('the predicate passed at construction is actually consulted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-task-predicate-'));
    const asked: string[] = [];
    const registry = new CrossSessionTaskRegistry(join(dir, 'task-graph.json'), {
      sessionExists: (id) => { asked.push(id); return id === 'alive'; },
      sweepIntervalMs: 0,
    });
    try {
      const alive = createTaskTool(registry, { resolveSessionId: () => 'alive' });
      const dead = createTaskTool(registry, { resolveSessionId: () => 'dead' });
      await call(alive, { mode: 'create', taskId: 'a', title: 'A' });
      await call(dead, { mode: 'create', taskId: 'b', title: 'B' });

      asked.length = 0;
      registry.reap();
      // It was consulted for both sessions...
      expect(new Set(asked)).toEqual(new Set(['alive', 'dead']));
      // ...and neither ref is gone yet, because both are inside the grace floor.
      expect(registry.getRef('dead', 'b')).not.toBeNull();
    } finally {
      registry.dispose();
    }
  });
});
