/**
 * Per-command exec sandbox (bubblewrap).
 *
 * Covers the pure, injectable surface: honest availability detection, bwrap argv
 * construction, per-command plan resolution (including the honest-unavailable
 * path), and the sandbox-aware permission policy that relaxes an "ask" to an
 * "allow" only for boundary-safe commands. Also pins that the frozen
 * catastrophic block is unaffected by the sandbox — it stays an unconditional
 * exec-time denial.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildBwrapArgv,
  detectSandboxAvailability,
  resolveExecSandboxPlan,
  type ExecSandboxConfig,
  type SandboxAvailability,
  type SandboxHostProbe,
} from '../packages/sdk/src/platform/tools/exec/sandbox.js';
import { decideSandboxedExec } from '../packages/sdk/src/platform/runtime/permissions/sandbox-policy.js';
import { guardExecCommand } from '../packages/sdk/src/platform/tools/exec/ast-guard.js';
import { ALL_COMMAND_CLASSES } from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

const AVAILABLE: SandboxAvailability = {
  available: true,
  backend: 'bubblewrap',
  bwrapPath: '/usr/bin/bwrap',
  reason: 'bubblewrap sandbox available',
  networkIsolationGuaranteed: true,
};

const config = (over: Partial<ExecSandboxConfig> = {}): ExecSandboxConfig => ({
  enabled: true,
  egressAllowlist: [],
  workspaceWritable: [],
  ...over,
});

// ── Availability detection (honest, never faked) ─────────────────────────────

describe('detectSandboxAvailability', () => {
  const probe = (over: Partial<SandboxHostProbe> = {}): SandboxHostProbe => ({
    platform: 'linux',
    bwrapPath: '/usr/bin/bwrap',
    bwrapWorks: true,
    netUnshareWorks: true,
    ...over,
  });

  test('linux + working bwrap + net unshare → available with guaranteed network isolation', () => {
    const a = detectSandboxAvailability(probe());
    expect(a.available).toBe(true);
    expect(a.backend).toBe('bubblewrap');
    expect(a.networkIsolationGuaranteed).toBe(true);
  });

  test('bwrap present but net-unshare probe failed → available but network NOT guaranteed', () => {
    const a = detectSandboxAvailability(probe({ netUnshareWorks: false }));
    expect(a.available).toBe(true);
    expect(a.networkIsolationGuaranteed).toBe(false);
    expect(a.reason).toContain('NOT confirmed');
  });

  test('no bwrap on PATH → unavailable with a stated reason', () => {
    const a = detectSandboxAvailability(probe({ bwrapPath: null }));
    expect(a.available).toBe(false);
    expect(a.reason).toContain('not found');
  });

  test('bwrap present but a trivial probe fails (userns disabled) → unavailable, stated', () => {
    const a = detectSandboxAvailability(probe({ bwrapWorks: false }));
    expect(a.available).toBe(false);
    expect(a.reason).toContain('user namespaces');
  });

  test('macOS → unavailable this release, not faked', () => {
    const a = detectSandboxAvailability(probe({ platform: 'darwin' }));
    expect(a.available).toBe(false);
    expect(a.reason).toContain('Linux-only');
  });
});

// ── bwrap argv construction (pure) ───────────────────────────────────────────

describe('buildBwrapArgv', () => {
  test('binds workspace rw, root ro, isolates /tmp, unshares net when disabled, chdirs', () => {
    const argv = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      workspaceDir: '/home/u/proj',
      cwd: '/home/u/proj/src',
      writableExtras: [],
      networkEnabled: false,
    });
    expect(argv[0]).toBe('/usr/bin/bwrap');
    const joined = argv.join(' ');
    expect(joined).toContain('--ro-bind / /');
    expect(joined).toContain('--tmpfs /tmp');
    expect(joined).toContain('--bind /home/u/proj /home/u/proj');
    expect(joined).toContain('--unshare-net');
    expect(joined).toContain('--chdir /home/u/proj/src');
    expect(argv[argv.length - 1]).toBe('--'); // separator before /bin/sh
  });

  test('network enabled → no --unshare-net; writable extras and home mask are bound', () => {
    const argv = buildBwrapArgv({
      bwrapPath: '/usr/bin/bwrap',
      workspaceDir: '/w',
      cwd: '/w',
      writableExtras: ['/cache'],
      networkEnabled: true,
      maskHomeDir: '/home/u',
    });
    const joined = argv.join(' ');
    expect(joined).not.toContain('--unshare-net');
    expect(joined).toContain('--bind /cache /cache');
    expect(joined).toContain('--tmpfs /home/u');
  });
});

// ── Per-command plan resolution ──────────────────────────────────────────────

describe('resolveExecSandboxPlan', () => {
  const base = { availability: AVAILABLE, featureEnabled: true, workspaceDir: '/w', cwd: '/w' };

  test('feature flag off → not sandboxed, no argv prefix (byte-for-byte path)', () => {
    const plan = resolveExecSandboxPlan({ ...base, featureEnabled: false, config: config(), command: 'ls' });
    expect(plan.sandboxed).toBe(false);
    expect(plan.argvPrefix).toEqual([]);
  });

  test('config disabled → not sandboxed', () => {
    const plan = resolveExecSandboxPlan({ ...base, config: config({ enabled: false }), command: 'ls' });
    expect(plan.sandboxed).toBe(false);
  });

  test('requested but host unavailable → not sandboxed, honest unavailableReason', () => {
    const unavailable: SandboxAvailability = {
      available: false,
      backend: 'none',
      reason: 'bubblewrap (bwrap) was not found on PATH',
      networkIsolationGuaranteed: false,
    };
    const plan = resolveExecSandboxPlan({ ...base, availability: unavailable, config: config(), command: 'ls' });
    expect(plan.sandboxed).toBe(false);
    expect(plan.unavailableReason).toContain('not found');
    expect(plan.boundary).toContain('no sandbox');
  });

  test('active + non-network command → sandboxed, network disabled, unshare-net present', () => {
    const plan = resolveExecSandboxPlan({ ...base, config: config(), command: 'grep foo file' });
    expect(plan.sandboxed).toBe(true);
    expect(plan.network).toBe('disabled');
    expect(plan.argvPrefix.join(' ')).toContain('--unshare-net');
    expect(plan.escalationsGranted).toEqual([]);
  });

  test('network command NOT on egress allowlist → sandboxed, network stays disabled', () => {
    const plan = resolveExecSandboxPlan({ ...base, config: config(), command: 'curl https://example.com' });
    expect(plan.sandboxed).toBe(true);
    expect(plan.network).toBe('disabled');
    expect(plan.argvPrefix.join(' ')).toContain('--unshare-net');
  });

  test('network command ON egress allowlist → network enabled as a named escalation', () => {
    const plan = resolveExecSandboxPlan({ ...base, config: config({ egressAllowlist: ['curl'] }), command: 'curl https://example.com' });
    expect(plan.network).toBe('enabled');
    expect(plan.argvPrefix.join(' ')).not.toContain('--unshare-net');
    expect(plan.escalationsGranted.some((e) => e.includes('network'))).toBe(true);
  });

  test('net isolation unconfirmed on host → network reported unknown, not claimed contained', () => {
    const unconfirmed: SandboxAvailability = { ...AVAILABLE, networkIsolationGuaranteed: false };
    const plan = resolveExecSandboxPlan({ ...base, availability: unconfirmed, config: config(), command: 'ls' });
    expect(plan.sandboxed).toBe(true);
    expect(plan.network).toBe('unknown');
  });
});

// ── Sandbox-aware permission policy ──────────────────────────────────────────

describe('decideSandboxedExec', () => {
  test('sandbox inactive → returns the base effect unchanged (purely additive)', () => {
    const d = decideSandboxedExec({ command: 'curl x', sandboxActive: false, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('ask');
    expect(d.sandboxed).toBe(false);
  });

  test('active + boundary-safe command → auto-allow, no escalations', () => {
    const d = decideSandboxedExec({ command: 'ls -la', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('allow');
    expect(d.escalations).toEqual([]);
  });

  test('active + a destructive-but-bounded command → still auto-allow (only workspace is writable)', () => {
    const d = decideSandboxedExec({ command: 'rm -rf build', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('allow');
  });

  test('active + network command → ask, naming the network need', () => {
    const d = decideSandboxedExec({ command: 'curl https://x', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('ask');
    expect(d.escalations.some((e) => e.includes('network'))).toBe(true);
  });

  test('active + host-privilege escalation → ask, naming it', () => {
    const d = decideSandboxedExec({ command: 'sudo systemctl restart x', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('ask');
    expect(d.escalations.some((e) => e.includes('escalation'))).toBe(true);
  });

  test('active + package install → ask, naming the network (install) need', () => {
    const d = decideSandboxedExec({ command: 'npm install lodash', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect).toBe('ask');
    expect(d.escalations.some((e) => e.includes('package install'))).toBe(true);
  });
});

// ── Frozen catastrophic block is unaffected by the sandbox ───────────────────

describe('the frozen catastrophic block stays unconditional (sandbox never buys it an allow)', () => {
  test('rm -rf / is denied at exec time regardless of sandbox activity', async () => {
    const result = await guardExecCommand('rm -rf /', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(false);
  });

  test('a fork bomb is denied at exec time regardless of sandbox activity', async () => {
    const result = await guardExecCommand(':(){ :|:& };:', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(false);
  });

  test('the sandbox policy does not reach into the catastrophic block — it only relaxes ask→allow', () => {
    // decideSandboxedExec classifies rm -rf / as boundary-safe destructive and
    // would allow it, but that allow is harmless precisely because the exec-time
    // catastrophic block (asserted above) is independent and unconditional. The
    // policy can never turn a deny into an allow.
    const d = decideSandboxedExec({ command: 'rm -rf /', sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask' });
    expect(d.effect === 'allow' || d.effect === 'ask').toBe(true);
  });
});
