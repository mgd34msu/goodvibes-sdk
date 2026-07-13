/**
 * exec-interactive.test.ts — the exec PTY prompt-answer path.
 *
 * All three exec spawn paths used to pipe stdout/stderr with stdin unwired,
 * so a child that stopped on a terminal prompt (ssh host-key confirmation,
 * credential ask) hung to timeout with the exchange lost. Covers:
 *   - honest PTY availability detection (pure, never faked)
 *   - PTY argv construction and its composition INSIDE the sandbox argv
 *     (the boundary stays the outermost layer under the PTY)
 *   - prompt-shape detection heuristics and their stated limits
 *   - the live answer path: a scripted child that prompts on /dev/tty (a
 *     prompt a pipe could never answer) completes through the brokered answer
 *   - a never-answered prompt times out with the prompt text on the result
 *   - a declined prompt stops the run honestly
 *   - the sandbox boundary asserted intact under the PTY (live, bwrap-gated)
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectPtyAvailability,
  probePtyHost,
  buildPtyArgv,
  findPendingPrompt,
  isPromptProneCommand,
  shouldRunInteractive,
  runInteractiveCommand,
  type ExecInteractionRuntime,
  type ExecPromptAsk,
  type PtyAvailability,
} from '../packages/sdk/src/platform/tools/exec/interactive.ts';
import {
  buildBwrapArgv,
  detectSandboxAvailability,
  probeSandboxHost,
} from '../packages/sdk/src/platform/tools/exec/sandbox.ts';
import { buildExecPromptAnswerHandler } from '../packages/sdk/src/platform/runtime/permissions/exec-prompt-wiring.ts';
import type { PermissionPromptRequest } from '../packages/sdk/src/platform/permissions/prompt.ts';
import { createExecTool } from '../packages/sdk/src/platform/tools/exec/runtime.ts';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../packages/sdk/src/platform/tools/shared/overflow.ts';

const LIVE_PTY = detectPtyAvailability(probePtyHost());
const LIVE_SANDBOX = detectSandboxAvailability(probeSandboxHost());

function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function interaction(over: Partial<ExecInteractionRuntime> = {}): ExecInteractionRuntime {
  return { availability: LIVE_PTY, quietWindowMs: 250, ...over };
}

// A child whose prompt is written to and read from /dev/tty — with plain
// pipes there IS no controlling terminal, so only a real PTY can answer it.
const TTY_PROMPT_SCRIPT =
  'printf "Continue? [y/n]: " > /dev/tty; read ans < /dev/tty; ' +
  'if [ "$ans" = "y" ]; then echo accepted; else echo rejected; exit 1; fi';

// ── Availability detection (honest, never faked) ─────────────────────────────

describe('detectPtyAvailability', () => {
  test('linux with script on PATH → available, util-linux flavor', () => {
    const a = detectPtyAvailability({ platform: 'linux', scriptPath: '/usr/bin/script' });
    expect(a.available).toBe(true);
    expect(a.backend).toBe('script');
    expect(a.flavor).toBe('util-linux');
  });

  test('darwin with script on PATH → available, bsd flavor', () => {
    const a = detectPtyAvailability({ platform: 'darwin', scriptPath: '/usr/bin/script' });
    expect(a.available).toBe(true);
    expect(a.flavor).toBe('bsd');
  });

  test('no script on PATH → unavailable with a stated reason', () => {
    const a = detectPtyAvailability({ platform: 'linux', scriptPath: null });
    expect(a.available).toBe(false);
    expect(a.reason).toContain('not found');
  });

  test('unsupported platform → unavailable, not faked', () => {
    const a = detectPtyAvailability({ platform: 'win32', scriptPath: '/usr/bin/script' });
    expect(a.available).toBe(false);
    expect(a.reason).toContain('win32');
  });
});

// ── PTY argv construction + sandbox composition ──────────────────────────────

describe('buildPtyArgv', () => {
  const avail = (flavor: 'util-linux' | 'bsd'): PtyAvailability => ({
    available: true, backend: 'script', scriptPath: '/usr/bin/script', flavor,
    reason: 'test',
  });

  test('util-linux flavor: script -qefc <cmd> /dev/null', () => {
    expect(buildPtyArgv(avail('util-linux'), 'ssh host')).toEqual([
      '/usr/bin/script', '-qefc', 'ssh host', '/dev/null',
    ]);
  });

  test('bsd flavor: script -q /dev/null /bin/sh -c <cmd>', () => {
    expect(buildPtyArgv(avail('bsd'), 'ssh host')).toEqual([
      '/usr/bin/script', '-q', '/dev/null', '/bin/sh', '-c', 'ssh host',
    ]);
  });

  test('throws rather than fake a PTY when unavailable', () => {
    expect(() => buildPtyArgv({ available: false, backend: 'none', reason: 'no' }, 'x')).toThrow();
  });

  test('the sandbox argv wraps the PTY argv — boundary outermost, unchanged', () => {
    const sandboxArgv = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap', workspaceDir: '/ws', cwd: '/ws',
      writableExtras: [], networkEnabled: false,
    });
    const ptyArgv = buildPtyArgv(avail('util-linux'), 'ssh host');
    const full = [...sandboxArgv, ...ptyArgv];
    // The boundary is the outermost layer: bwrap first, PTY allocation inside.
    expect(full[0]).toBe('/usr/bin/bwrap');
    const dashDash = full.indexOf('--');
    expect(dashDash).toBeGreaterThan(0);
    expect(full.slice(dashDash + 1)).toEqual(['/usr/bin/script', '-qefc', 'ssh host', '/dev/null']);
    // The sandbox argv itself is byte-for-byte what the non-PTY path uses.
    expect(full.slice(0, sandboxArgv.length)).toEqual(sandboxArgv);
  });
});

// ── Prompt-shape detection (heuristic; limits stated in the module doc) ─────

describe('findPendingPrompt', () => {
  test('detects colon-terminated credential asks', () => {
    expect(findPendingPrompt('some output\nPassword: ')).toBe('Password:');
    expect(findPendingPrompt("Username for 'https://github.com':")).toBe("Username for 'https://github.com':");
  });

  test('detects question and bracket-choice prompts', () => {
    expect(findPendingPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '))
      .toContain('continue connecting');
    expect(findPendingPrompt('Overwrite? [y/N]')).toBe('Overwrite? [y/N]');
  });

  test('a newline-terminated tail is not a prompt (the line completed)', () => {
    expect(findPendingPrompt('Password:\n')).toBeNull();
    expect(findPendingPrompt('building...\ndone\n')).toBeNull();
  });

  test('ordinary trailing output is not a prompt', () => {
    expect(findPendingPrompt('compiling module 3 of 7')).toBeNull();
    expect(findPendingPrompt('')).toBeNull();
  });

  test('an absurdly long tail is not a prompt (bounded heuristic)', () => {
    expect(findPendingPrompt(`${'x'.repeat(600)}:`)).toBeNull();
  });
});

describe('isPromptProneCommand / shouldRunInteractive', () => {
  test('ssh/scp/sudo are prompt-prone; ls/git are not', () => {
    expect(isPromptProneCommand('ssh host uptime')).toBe(true);
    expect(isPromptProneCommand('scp f host:/tmp/')).toBe(true);
    expect(isPromptProneCommand('sudo apt update')).toBe(true);
    expect(isPromptProneCommand('ls -la')).toBe(false);
    expect(isPromptProneCommand('git status')).toBe(false);
  });

  test('explicit interactive:true engages; interactive:false vetoes auto-engagement', () => {
    const avail: ExecInteractionRuntime = {
      availability: { available: true, backend: 'script', scriptPath: '/usr/bin/script', flavor: 'util-linux', reason: 't' },
    };
    expect(shouldRunInteractive(avail, { cmd: 'ls', interactive: true }, 'ls')).toBe(true);
    expect(shouldRunInteractive(avail, { cmd: 'ssh h', interactive: false }, 'ssh h')).toBe(false);
    expect(shouldRunInteractive(avail, { cmd: 'ssh h' }, 'ssh h')).toBe(true);
    expect(shouldRunInteractive(avail, { cmd: 'ls' }, 'ls')).toBe(false);
  });

  test('never engages without an available PTY backend, and never for background/until', () => {
    const unavailable: ExecInteractionRuntime = {
      availability: { available: false, backend: 'none', reason: 'no script' },
    };
    expect(shouldRunInteractive(unavailable, { cmd: 'ssh h', interactive: true }, 'ssh h')).toBe(false);
    expect(shouldRunInteractive(null, { cmd: 'ssh h' }, 'ssh h')).toBe(false);
    const avail: ExecInteractionRuntime = {
      availability: { available: true, backend: 'script', scriptPath: '/usr/bin/script', flavor: 'util-linux', reason: 't' },
    };
    expect(shouldRunInteractive(avail, { cmd: 'ssh h', background: true }, 'ssh h')).toBe(false);
    expect(shouldRunInteractive(avail, { cmd: 'ssh h', until: { pattern: 'x' } }, 'ssh h')).toBe(false);
  });
});

// ── The approval-broker bridge (one learned pattern, not five) ───────────────

describe('buildExecPromptAnswerHandler', () => {
  const ask: ExecPromptAsk = {
    command: 'ssh host',
    prompt: 'Are you sure you want to continue connecting (yes/no)?',
    recentOutput: 'The authenticity of host ...',
    workingDirectory: '/ws',
  };

  test('approval with modifiedArgs.answer feeds the typed reply back', async () => {
    const requests: PermissionPromptRequest[] = [];
    const handler = buildExecPromptAnswerHandler({
      requestApproval: async ({ request }) => {
        requests.push(request);
        return { approved: true, modifiedArgs: { answer: 'yes' } };
      },
    });
    const answer = await handler(ask);
    expect(answer).toEqual({ answered: true, text: 'yes' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tool).toBe('exec:prompt');
    expect(requests[0]!.category).toBe('execute');
    expect(requests[0]!.attribution).toEqual({
      kind: 'exec-prompt', command: 'ssh host', prompt: ask.prompt,
    });
    expect(requests[0]!.workingDirectory).toBe('/ws');
  });

  test('denial declines the prompt', async () => {
    const handler = buildExecPromptAnswerHandler({
      requestApproval: async () => ({ approved: false }),
    });
    expect(await handler(ask)).toEqual({ answered: false });
  });

  test('approval WITHOUT a typed answer is a decline — nothing is fabricated', async () => {
    const handler = buildExecPromptAnswerHandler({
      requestApproval: async () => ({ approved: true }),
    });
    expect(await handler(ask)).toEqual({ answered: false });
  });
});

// ── Live PTY tests (probed; skipped honestly when script(1) is absent) ───────

describe.skipIf(!LIVE_PTY.available)('runInteractiveCommand (live PTY)', () => {
  test('a /dev/tty prompt completes through the brokered answer path', async () => {
    const asks: ExecPromptAsk[] = [];
    const result = await runInteractiveCommand({
      cmdStr: TTY_PROMPT_SCRIPT,
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: 15_000,
      startTime: Date.now(),
      sandboxArgv: [],
      interaction: interaction({
        requestPromptAnswer: async (ask) => {
          asks.push(ask);
          return { answered: true, text: 'y' };
        },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.pty).toBe(true);
    expect(result.prompts_answered).toBe(1);
    // The full exchange lands in the transcript: the prompt, the echoed
    // answer, and the post-answer output.
    expect(result.stdout).toContain('Continue? [y/n]:');
    expect(result.stdout).toContain('accepted');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.prompt).toBe('Continue? [y/n]:');
    expect(asks[0]!.command).toBe(TTY_PROMPT_SCRIPT);
  }, 20_000);

  test('a never-answered prompt times out with the prompt text on the honest result', async () => {
    const result = await runInteractiveCommand({
      cmdStr: TTY_PROMPT_SCRIPT,
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: 2_500,
      startTime: Date.now(),
      sandboxArgv: [],
      interaction: interaction({
        // The seam never resolves — surface ignored it / human walked away.
        requestPromptAnswer: () => new Promise(() => {}),
      }),
    });

    expect(result.success).toBe(false);
    expect(result.timed_out).toBe(true);
    expect(result.pending_prompt).toBe('Continue? [y/n]:');
    expect(result.stdout).toContain('Continue? [y/n]:');
  }, 20_000);

  test('a detected prompt with NO wired answer seam still times out with the prompt text', async () => {
    const result = await runInteractiveCommand({
      cmdStr: TTY_PROMPT_SCRIPT,
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: 2_500,
      startTime: Date.now(),
      sandboxArgv: [],
      interaction: interaction(), // no requestPromptAnswer
    });

    expect(result.success).toBe(false);
    expect(result.timed_out).toBe(true);
    expect(result.pending_prompt).toBe('Continue? [y/n]:');
  }, 20_000);

  test('a declined prompt stops the run honestly instead of burning the timeout', async () => {
    const start = Date.now();
    const result = await runInteractiveCommand({
      cmdStr: TTY_PROMPT_SCRIPT,
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: 60_000,
      startTime: start,
      sandboxArgv: [],
      interaction: interaction({
        requestPromptAnswer: async () => ({ answered: false }),
      }),
    });

    expect(result.success).toBe(false);
    expect(result.prompt_declined).toBe(true);
    expect(result.pending_prompt).toBe('Continue? [y/n]:');
    // Stopped promptly — nowhere near the 60s timeout.
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 30_000);

  test('multiple sequential prompts are each answered on the same continuing run', async () => {
    const script =
      'printf "First name: " > /dev/tty; read a < /dev/tty; ' +
      'printf "Last name: " > /dev/tty; read b < /dev/tty; ' +
      'echo "hello $a $b"';
    const answers = ['Ada', 'Lovelace'];
    const result = await runInteractiveCommand({
      cmdStr: script,
      cwd: undefined,
      env: process.env as Record<string, string>,
      timeoutMs: 15_000,
      startTime: Date.now(),
      sandboxArgv: [],
      interaction: interaction({
        requestPromptAnswer: async () => ({ answered: true, text: answers.shift()! }),
      }),
    });

    expect(result.success).toBe(true);
    expect(result.prompts_answered).toBe(2);
    expect(result.stdout).toContain('hello Ada Lovelace');
  }, 20_000);

  test('end-to-end through createExecTool: interactive command answers and completes', async () => {
    const root = tempRoot('gv-exec-interactive-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      interaction: interaction({
        requestPromptAnswer: async () => ({ answered: true, text: 'y' }),
      }),
    });

    const result = await tool.execute({
      commands: [{ cmd: TTY_PROMPT_SCRIPT, interactive: true }],
      verbosity: 'verbose',
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as {
      stdout?: string; pty?: boolean; prompts_answered?: number;
    };
    expect(output.pty).toBe(true);
    expect(output.prompts_answered).toBe(1);
    expect(output.stdout).toContain('accepted');
  }, 20_000);

  test('a non-interactive command through a tool WITH interaction wired takes the unchanged pipe path', async () => {
    const root = tempRoot('gv-exec-noninteractive-');
    const tool = createExecTool(new ProcessManager(), {
      overflowHandler: new OverflowHandler({ baseDir: root }),
      defaultWorkingDirectory: root,
      interaction: interaction({
        requestPromptAnswer: async () => ({ answered: true, text: 'y' }),
      }),
    });

    const result = await tool.execute({ commands: [{ cmd: 'echo plain' }], verbosity: 'verbose' });
    expect(result.success).toBe(true);
    const output = JSON.parse(result.output ?? '{}') as { stdout?: string; pty?: boolean };
    expect(output.stdout?.trim()).toBe('plain');
    expect(output.pty).toBeUndefined();
  });
});

// ── Sandbox boundary intact under the PTY (live, bwrap-gated) ────────────────

describe.skipIf(!LIVE_PTY.available || !LIVE_SANDBOX.available)(
  'sandbox boundary under the PTY (live bwrap)',
  () => {
    test('the bwrap boundary holds under the PTY: workspace writable, outside read-only', async () => {
      const workspace = tempRoot('gv-pty-sandbox-ws-');
      const outside = tempRoot('gv-pty-sandbox-outside-');
      const sandboxArgv = buildBwrapArgv({
        bwrapPath: LIVE_SANDBOX.bwrapPath!,
        workspaceDir: workspace,
        cwd: workspace,
        writableExtras: [],
        networkEnabled: false,
      });

      // Inside the boundary + under the PTY: a workspace write succeeds, a
      // write outside the workspace fails — the same guarantees the non-PTY
      // sandboxed path provides.
      const result = await runInteractiveCommand({
        cmdStr:
          `touch ${workspace}/inside.txt && echo inside-ok; ` +
          `touch ${outside}/outside.txt 2>/dev/null && echo outside-ok || echo outside-blocked`,
        cwd: workspace,
        env: process.env as Record<string, string>,
        timeoutMs: 15_000,
        startTime: Date.now(),
        sandboxArgv,
        interaction: interaction(),
      });

      expect(result.pty).toBe(true);
      expect(result.stdout).toContain('inside-ok');
      expect(result.stdout).toContain('outside-blocked');
      expect(result.stdout).not.toContain('outside-ok');
      expect(existsSync(join(workspace, 'inside.txt'))).toBe(true);
      expect(existsSync(join(outside, 'outside.txt'))).toBe(false);
    }, 30_000);

    test('the answer path works INSIDE the boundary too', async () => {
      const workspace = tempRoot('gv-pty-sandbox-answer-');
      const sandboxArgv = buildBwrapArgv({
        bwrapPath: LIVE_SANDBOX.bwrapPath!,
        workspaceDir: workspace,
        cwd: workspace,
        writableExtras: [],
        networkEnabled: false,
      });

      const result = await runInteractiveCommand({
        cmdStr: TTY_PROMPT_SCRIPT,
        cwd: workspace,
        env: process.env as Record<string, string>,
        timeoutMs: 15_000,
        startTime: Date.now(),
        sandboxArgv,
        interaction: interaction({
          requestPromptAnswer: async () => ({ answered: true, text: 'y' }),
        }),
      });

      expect(result.success).toBe(true);
      expect(result.prompts_answered).toBe(1);
      expect(result.stdout).toContain('accepted');
    }, 30_000);
  },
);
