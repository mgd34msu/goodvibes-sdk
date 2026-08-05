/**
 * A sandboxed exec result says it is sandboxed.
 *
 * The boundary has a different world than the host: a separate network
 * namespace whose `127.0.0.1` is its own (so the daemon on the host's
 * 127.0.0.1:3421 refuses connections from inside while the agent process
 * reaches it fine), a read-only filesystem outside the workspace, a masked
 * /tmp and $HOME, and narrower device and process visibility. None of that was
 * stated in the result, and the sandbox fields that did exist survived only at
 * `verbose` — so at the default verbosity a contained run was indistinguishable
 * from a host run. A probe that found no Bluetooth adapter inside the boundary
 * was read as the user's headset not existing.
 *
 * These tests pin the standing one-line note, and pin that a refused loopback
 * connection to the daemon carries it.
 */
import { describe, expect, test } from 'bun:test';
import {
  attachSandboxMeta,
  buildSandboxNote,
  resolveExecSandboxPlan,
  type ExecSandboxConfig,
  type ExecSandboxPlan,
  type SandboxAvailability,
} from '../packages/sdk/src/platform/tools/exec/sandbox.js';
import { formatResult } from '../packages/sdk/src/platform/tools/exec/result-format.js';
import type { ExecCommandResult } from '../packages/sdk/src/platform/tools/exec/schema.js';

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

/** The plan for a command that runs inside the boundary with network isolated. */
function isolatedPlan(command = 'bluetoothctl devices'): ExecSandboxPlan {
  return resolveExecSandboxPlan({
    config: config(),
    availability: AVAILABLE,
    featureEnabled: true,
    command,
    workspaceDir: '/w',
    cwd: '/w',
  });
}

function resultOf(over: Partial<ExecCommandResult> = {}): ExecCommandResult {
  return {
    cmd: 'probe',
    exit_code: 0,
    success: true,
    stdout: '',
    stderr: '',
    ...over,
  } as ExecCommandResult;
}

describe('buildSandboxNote — names the isolation that actually applies', () => {
  test('a network-isolated run says host localhost services are unreachable', () => {
    const note = buildSandboxNote(isolatedPlan());

    expect(note).toContain('sandboxed');
    expect(note).toContain('network namespace');
    expect(note).toContain('unreachable');
    // It names the daemon and port specifically, because that refusal is the
    // one most easily mistaken for the daemon being down.
    expect(note).toContain('127.0.0.1:3421');
    // And it names the one action that changes the posture.
    expect(note).toContain('egressAllowlist');
  });

  test('it warns that absence inside the boundary is not absence on the host', () => {
    expect(buildSandboxNote(isolatedPlan())).toContain('not absence on the host');
  });

  test('it is one line, not a lecture', () => {
    expect(buildSandboxNote(isolatedPlan()).split('\n')).toHaveLength(1);
  });

  test('it does not claim a $HOME mask that was not applied', () => {
    // No homeDir was passed, so $HOME was not masked and the note must not say
    // it was. A note that overstates the boundary is the same defect as one
    // that hides it.
    expect(buildSandboxNote(isolatedPlan())).not.toContain('$HOME masked');
  });

  test('it claims the $HOME mask when the run actually applied one', () => {
    const plan = resolveExecSandboxPlan({
      config: config(),
      availability: AVAILABLE,
      featureEnabled: true,
      command: 'ls',
      workspaceDir: '/w',
      cwd: '/w',
      homeDir: '/home/someone',
    });

    expect(plan.homeMasked).toBe(true);
    expect(buildSandboxNote(plan)).toContain('$HOME masked');
  });

  test('unconfirmed network isolation is not reported as isolation', () => {
    const plan = resolveExecSandboxPlan({
      config: config(),
      availability: { ...AVAILABLE, networkIsolationGuaranteed: false },
      featureEnabled: true,
      command: 'ls',
      workspaceDir: '/w',
      cwd: '/w',
    });

    expect(plan.network).toBe('unknown');
    expect(buildSandboxNote(plan)).toContain('unconfirmed');
  });

  test('a run that shares the host network does not claim localhost is unreachable', () => {
    const plan = resolveExecSandboxPlan({
      config: config({ egressAllowlist: ['curl'] }),
      availability: AVAILABLE,
      featureEnabled: true,
      command: 'curl http://127.0.0.1:3421/health',
      workspaceDir: '/w',
      cwd: '/w',
    });

    expect(plan.network).toBe('enabled');
    expect(buildSandboxNote(plan)).toContain('reachable');
    expect(buildSandboxNote(plan)).not.toContain('unreachable');
  });
});

describe('the note reaches the caller at every verbosity', () => {
  for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose'] as const) {
    test(`${verbosity} carries sandboxed and the note`, () => {
      const withMeta = attachSandboxMeta(resultOf(), isolatedPlan());
      const shaped = formatResult(withMeta, verbosity) as Record<string, unknown>;

      expect(shaped.sandboxed).toBe(true);
      expect(String(shaped.sandbox_note)).toContain('network namespace');
    });
  }

  test('an unsandboxed run stays quiet — no note, no fields', () => {
    const shaped = formatResult(resultOf(), 'standard') as Record<string, unknown>;

    expect(shaped.sandboxed).toBeUndefined();
    expect(shaped.sandbox_note).toBeUndefined();
  });
});

describe('a refused loopback probe of the daemon explains itself', () => {
  test('the connection-refused output carries the sandbox note', () => {
    // What a `curl http://127.0.0.1:3421/...` looks like from inside the
    // boundary: the daemon is running on the host, and the namespace's own
    // loopback has nothing listening on it.
    const refused = resultOf({
      cmd: 'curl -s http://127.0.0.1:3421/health',
      exit_code: 7,
      success: false,
      stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 3421: Connection refused',
    });

    const shaped = formatResult(
      attachSandboxMeta(refused, isolatedPlan('curl -s http://127.0.0.1:3421/health')),
      'standard',
    ) as Record<string, unknown>;

    expect(String(shaped.stderr)).toContain('Connection refused');
    // The refusal is never presented bare: the reason it was refused is in the
    // same result, so "the daemon is down" is not the available conclusion.
    expect(String(shaped.sandbox_note)).toContain('127.0.0.1:3421');
    expect(String(shaped.sandbox_note)).toContain('even while it is running');
  });

  test('the same refusal at minimal verbosity still carries the note', () => {
    const refused = resultOf({
      exit_code: 7,
      success: false,
      stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 3421: Connection refused',
    });
    const shaped = formatResult(attachSandboxMeta(refused, isolatedPlan()), 'minimal') as Record<
      string,
      unknown
    >;

    expect(String(shaped.sandbox_note)).toContain('unreachable');
  });
});
