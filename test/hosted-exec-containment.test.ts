/**
 * hosted-exec-containment.test.ts — a hosted conversational turn does not get
 * the host, and it does not get the owner's terminal.
 *
 * Three layers, pinned separately so a regression says which one moved:
 *
 *  1. The containment decision (exec/containment.ts) — pure. Whether a
 *     composition that REQUIRES the boundary may run a command given the plan
 *     the sandbox layer resolved, and whether an omitted posture changes
 *     anything (it must not).
 *  2. The owner-terminal guard (exec/owner-terminal-guard.ts) — pure, in
 *     benign/malicious pairs per the guard discipline: for every refusal there
 *     is a neighbouring command that must still be allowed, so the guard cannot
 *     pass by refusing everything.
 *  3. The exec tool end to end — a real `createExecTool` under each posture,
 *     because the decision functions being right is not the same claim as the
 *     tool consulting them on every path (foreground, retried, background).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideExecContainment,
  type ExecContainmentRequirement,
} from '../packages/sdk/src/platform/tools/exec/containment.ts';
import {
  decideOwnerTerminalAccess,
  PLATFORM_TMUX_SESSION_PREFIX,
  type OwnerTerminalGuard,
} from '../packages/sdk/src/platform/tools/exec/owner-terminal-guard.ts';
import type { ExecSandboxPlan } from '../packages/sdk/src/platform/tools/exec/sandbox.ts';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/index.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

const REQUIRED: ExecContainmentRequirement = {
  posture: 'required',
  reason: 'this is a daemon-hosted conversational turn',
};
const HOST_ALLOWED: ExecContainmentRequirement = {
  posture: 'host-allowed',
  reason: 'this hosted workstream was composed with the host explicitly granted',
};
const ENFORCED: OwnerTerminalGuard = { posture: 'enforced' };

const contained: ExecSandboxPlan = {
  sandboxed: true,
  argvPrefix: ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--'],
  boundary: 'bubblewrap: workspace writable, system read-only',
  network: 'disabled',
  escalationsGranted: [],
  homeMasked: true,
};
const unavailable: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: bubblewrap (bwrap) was not found on PATH',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
  unavailableReason: 'per-command exec sandbox unavailable: bubblewrap (bwrap) was not found on PATH',
};
const switchedOff: ExecSandboxPlan = {
  sandboxed: false,
  argvPrefix: [],
  boundary: 'no sandbox: per-command exec sandbox is not enabled',
  network: 'enabled',
  escalationsGranted: [],
  homeMasked: false,
};

// ── 1. The containment decision ─────────────────────────────────────────────

describe('decideExecContainment', () => {
  test('required + a real boundary → allowed', () => {
    expect(decideExecContainment(REQUIRED, contained).allowed).toBe(true);
  });

  test('required + no boundary because the host cannot provide one → refused, naming why', () => {
    const decision = decideExecContainment(REQUIRED, unavailable);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('bubblewrap (bwrap) was not found on PATH');
    expect(decision.refusal).toContain('daemon-hosted conversational turn');
  });

  test('required + the sandbox switched off → still refused; a config switch is not a grant', () => {
    const decision = decideExecContainment(REQUIRED, switchedOff);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('not enabled');
  });

  test('required + no sandbox wired at all → refused, and says so plainly', () => {
    const decision = decideExecContainment(REQUIRED, null);
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain('no exec sandbox is wired into this session');
  });

  test('host-allowed + no boundary → allowed; this is the terminal posture, unchanged', () => {
    expect(decideExecContainment(HOST_ALLOWED, unavailable).allowed).toBe(true);
    expect(decideExecContainment(HOST_ALLOWED, null).allowed).toBe(true);
  });

  test('an omitted posture never tightens a caller: undefined and null both allow', () => {
    expect(decideExecContainment(undefined, null).allowed).toBe(true);
    expect(decideExecContainment(null, unavailable).allowed).toBe(true);
  });
});

// ── 2. The owner-terminal guard, in benign/malicious pairs ──────────────────

describe('decideOwnerTerminalAccess', () => {
  const judge = (command: string, guard: OwnerTerminalGuard = ENFORCED) =>
    decideOwnerTerminalAccess(command, guard);

  test('off (and omitted) is a no-op: the same command that refuses when enforced runs', () => {
    expect(judge('tmux send-keys -t main "ls" Enter', { posture: 'off' }).allowed).toBe(true);
    expect(decideOwnerTerminalAccess('tmux send-keys -t main "ls" Enter', undefined).allowed).toBe(true);
    expect(judge('tmux send-keys -t main "ls" Enter').allowed).toBe(false);
  });

  describe('driving a session', () => {
    test('MALICIOUS: send-keys into the owner\'s pane is refused, naming the rule', () => {
      const decision = judge('tmux send-keys -t main "goodvibes-agent" Enter');
      expect(decision.allowed).toBe(false);
      expect(decision.refusal).toContain('owner\'s terminal is untouchable');
      expect(decision.refusal).toContain('did not create');
    });

    test('BENIGN: send-keys into a session this platform named is allowed', () => {
      expect(judge(`tmux send-keys -t ${PLATFORM_TMUX_SESSION_PREFIX}build "bun test" Enter`).allowed).toBe(true);
    });

    test('BENIGN: a window/pane inside a platform session is still the platform\'s', () => {
      expect(judge(`tmux send-keys -t ${PLATFORM_TMUX_SESSION_PREFIX}build:0.1 "ls" Enter`).allowed).toBe(true);
    });

    test('MALICIOUS: a bare pane id proves nothing about who created it → refused', () => {
      expect(judge('tmux send-keys -t %3 C-c').allowed).toBe(false);
      expect(judge('tmux send-keys -t @2 C-c').allowed).toBe(false);
      expect(judge('tmux send-keys -t $1 C-c').allowed).toBe(false);
    });

    test('MALICIOUS: no target at all acts on the server\'s current session → refused', () => {
      expect(judge('tmux send-keys "rm -rf build" Enter').allowed).toBe(false);
      expect(judge('tmux kill-server').allowed).toBe(false);
    });
  });

  describe('killing and resizing', () => {
    test('MALICIOUS: kill-session / kill-pane / resize-pane on the owner\'s are refused', () => {
      expect(judge('tmux kill-session -t main').allowed).toBe(false);
      expect(judge('tmux kill-pane -t work:1.0').allowed).toBe(false);
      expect(judge('tmux resize-pane -t main -D 10').allowed).toBe(false);
      expect(judge('tmux respawn-pane -k -t main').allowed).toBe(false);
      expect(judge('tmux rename-session -t main scratch').allowed).toBe(false);
    });

    test('BENIGN: the same verbs against the platform\'s own session are allowed', () => {
      expect(judge(`tmux kill-session -t ${PLATFORM_TMUX_SESSION_PREFIX}build`).allowed).toBe(true);
      expect(judge(`tmux resize-pane -t ${PLATFORM_TMUX_SESSION_PREFIX}build -D 10`).allowed).toBe(true);
    });

    test('MALICIOUS: `-a` inverts the target — an owned name does not make it safe', () => {
      // `kill-session -a -t goodvibes-build` kills every OTHER session on the
      // server. It reads as a command about the platform's own session.
      const decision = judge(`tmux kill-session -a -t ${PLATFORM_TMUX_SESSION_PREFIX}build`);
      expect(decision.allowed).toBe(false);
      expect(decision.refusal).toContain('everything EXCEPT its target');
    });

    test('MALICIOUS: a swap/join SOURCE is a target too', () => {
      expect(judge(`tmux swap-pane -s main -t ${PLATFORM_TMUX_SESSION_PREFIX}build`).allowed).toBe(false);
      expect(judge(`tmux join-pane -s main:1 -t ${PLATFORM_TMUX_SESSION_PREFIX}build`).allowed).toBe(false);
    });

    test('BENIGN: source and target both ours is allowed', () => {
      const p = PLATFORM_TMUX_SESSION_PREFIX;
      expect(judge(`tmux swap-pane -s ${p}a -t ${p}b`).allowed).toBe(true);
    });
  });

  describe('creating the platform\'s own sessions', () => {
    test('BENIGN: a detached new session is not the owner\'s terminal', () => {
      expect(judge(`tmux new-session -d -s ${PLATFORM_TMUX_SESSION_PREFIX}build bun test`).allowed).toBe(true);
      expect(judge('tmux new-session -d').allowed).toBe(true);
    });

    test('BENIGN: -s on a plain create is the NEW name, not a target — any name is fine', () => {
      // Refusing this would refuse a command that touches nothing: without -A,
      // an already-taken name is a tmux error, not an attach.
      expect(judge('tmux new-session -d -s build bun test').allowed).toBe(true);
    });

    test('MALICIOUS: -t on new-session GROUPS with an existing session → refused', () => {
      expect(judge('tmux new-session -d -t main').allowed).toBe(false);
    });

    test('MALICIOUS: -A can land on an EXISTING session, so a foreign name is refused', () => {
      expect(judge('tmux new-session -A -s main').allowed).toBe(false);
    });

    test('BENIGN: -A on the platform\'s own name is allowed', () => {
      expect(judge(`tmux new-session -A -s ${PLATFORM_TMUX_SESSION_PREFIX}build`).allowed).toBe(true);
    });

    test('MALICIOUS: attaching to the owner\'s session is refused', () => {
      expect(judge('tmux attach-session -t main').allowed).toBe(false);
      expect(judge('tmux attach -t main').allowed).toBe(false);
    });

    test('MALICIOUS: bare `tmux` attaches to whatever the server has → refused', () => {
      expect(judge('tmux').allowed).toBe(false);
    });
  });

  describe('reading is not touching', () => {
    test('BENIGN: the observation verbs the fleet view already runs stay allowed', () => {
      expect(judge('tmux list-sessions').allowed).toBe(true);
      expect(judge("tmux list-panes -a -F '#{pane_tty} #{pane_id}'").allowed).toBe(true);
      expect(judge('tmux has-session -t main').allowed).toBe(true);
      expect(judge('tmux capture-pane -p -t main').allowed).toBe(true);
    });
  });

  describe('the ways round it', () => {
    test('MALICIOUS: a server-socket flag does not hide the verb', () => {
      expect(judge('tmux -L sock send-keys -t main "ls" Enter').allowed).toBe(false);
      expect(judge('tmux -S /tmp/s send-keys -t main "ls" Enter').allowed).toBe(false);
    });

    test('MALICIOUS: hiding it in a compound command is still found', () => {
      expect(judge('echo hi && tmux send-keys -t main "ls" Enter').allowed).toBe(false);
      expect(judge('true; tmux kill-session -t main').allowed).toBe(false);
    });

    test('BENIGN: a command that merely mentions tmux is not a tmux invocation', () => {
      expect(judge('grep -r tmux ~/.config').allowed).toBe(true);
      expect(judge('echo "tmux send-keys -t main"').allowed).toBe(true);
    });

    test('BENIGN: a composition may register extra session names it owns', () => {
      const guard: OwnerTerminalGuard = { posture: 'enforced', ownedSessionNames: ['ci-runner'] };
      expect(decideOwnerTerminalAccess('tmux send-keys -t ci-runner "bun test" Enter', guard).allowed).toBe(true);
      expect(decideOwnerTerminalAccess('tmux send-keys -t main "bun test" Enter', guard).allowed).toBe(false);
    });
  });
});

// ── 3. The exec tool, end to end ────────────────────────────────────────────

describe('exec tool under a hosted conversational posture', () => {
  const roots: string[] = [];
  const makeTool = (over: {
    containment?: ExecContainmentRequirement | undefined;
    ownerTerminal?: OwnerTerminalGuard | undefined;
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'gv-hosted-exec-'));
    roots.push(root);
    return createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      // No sandbox wiring at all: the composition asked for containment and the
      // boundary is absent, which is exactly the shape the incident had.
      ...(over.containment ? { containment: over.containment } : {}),
      ...(over.ownerTerminal ? { ownerTerminal: over.ownerTerminal } : {}),
    });
  };
  const run = async (tool: ReturnType<typeof createExecTool>, cmd: string, extra: Record<string, unknown> = {}) => {
    const result = await tool.execute({ commands: [{ cmd, ...extra }] });
    return { result, output: JSON.parse(String(result.output ?? '{}')) as Record<string, unknown> };
  };

  test('required + no boundary → the command does not run, and says why', async () => {
    const { result, output } = await run(makeTool({ containment: REQUIRED }), 'echo contained-or-not');
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('requires commands to run inside the exec boundary');
    expect(String(output['stdout'])).not.toContain('contained-or-not');
  });

  test('the same command under the terminal posture runs, unchanged', async () => {
    const { result, output } = await run(makeTool({ containment: HOST_ALLOWED }), 'echo contained-or-not');
    expect(result.success).toBe(true);
    expect(String(output['stdout'])).toContain('contained-or-not');
  });

  test('with no containment stated at all it runs, unchanged', async () => {
    const { result } = await run(makeTool({}), 'echo plain');
    expect(result.success).toBe(true);
  });

  test('`background: true` is not the spelling that gets a contained turn onto the host', async () => {
    const { result, output } = await run(
      makeTool({ containment: REQUIRED }),
      'sleep 30',
      { background: true },
    );
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('background command cannot run inside the exec boundary');
  });

  test('the owner-terminal guard refuses through the tool, boundary or not', async () => {
    const { result, output } = await run(
      makeTool({ ownerTerminal: ENFORCED }),
      'tmux send-keys -t main "goodvibes-agent" Enter',
    );
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('owner\'s terminal is untouchable');
  });

  test('a backgrounded tmux send-keys is refused too — the guard runs before the detach', async () => {
    const { result, output } = await run(
      makeTool({ ownerTerminal: ENFORCED }),
      'tmux send-keys -t main "ls" Enter',
      { background: true },
    );
    expect(result.success).toBe(false);
    expect(String(output['stderr'])).toContain('owner\'s terminal is untouchable');
  });

  test('the platform driving its OWN tmux session still works through the tool', async () => {
    // Refused only if the guard fires; tmux itself need not be installed for
    // the guard's verdict, so this asserts the guard let it through rather
    // than asserting tmux succeeded.
    const { output } = await run(
      makeTool({ ownerTerminal: ENFORCED }),
      `tmux has-session -t ${PLATFORM_TMUX_SESSION_PREFIX}build`,
    );
    expect(String(output['stderr'] ?? '')).not.toContain('owner\'s terminal is untouchable');
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});
