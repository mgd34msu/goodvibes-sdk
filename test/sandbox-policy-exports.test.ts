/**
 * sandbox-policy-exports.test.ts
 *
 * Proves the sandbox policy surface is reachable from its public package
 * subpaths — the gap deliverable this closes: `decideSandboxedExec`,
 * `detectSandboxAvailability`, and `probeSandboxHost` existed but no public
 * subpath exported them, so a consumer could not wire an approval flow to the
 * sandbox policy. These imports resolve through the package `exports` map
 * against the built dist, so a broken/absent subpath fails the import.
 */
import { describe, expect, test } from 'bun:test';
import {
  decideSandboxedExec,
  type SandboxPolicyDecision,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/sandbox-policy';
import {
  detectSandboxAvailability,
  probeSandboxHost,
} from '@pellux/goodvibes-sdk/platform/tools/exec/sandbox';

describe('sandbox policy public subpaths', () => {
  test('decideSandboxedExec is exported and relaxes a boundary-safe ask to an allow', () => {
    const decision: SandboxPolicyDecision = decideSandboxedExec({
      command: 'ls -la',
      sandboxActive: true,
      egressAllowlist: [],
      baseEffectWhenNotSandboxed: 'ask',
    });
    expect(decision.effect).toBe('allow');
    expect(decision.sandboxed).toBe(true);
    expect(decision.escalations).toEqual([]);
  });

  test('decideSandboxedExec names a network escalation instead of auto-allowing', () => {
    const decision = decideSandboxedExec({
      command: 'curl https://example.com',
      sandboxActive: true,
      egressAllowlist: [],
      baseEffectWhenNotSandboxed: 'ask',
    });
    expect(decision.effect).toBe('ask');
    expect(decision.escalations.some((e) => e.includes('network'))).toBe(true);
  });

  test('decideSandboxedExec passes the base effect through when the sandbox is inactive', () => {
    const decision = decideSandboxedExec({
      command: 'ls',
      sandboxActive: false,
      egressAllowlist: [],
      baseEffectWhenNotSandboxed: 'ask',
    });
    expect(decision.effect).toBe('ask');
    expect(decision.sandboxed).toBe(false);
  });

  test('detectSandboxAvailability is exported and reasons purely over a host probe', () => {
    const availability = detectSandboxAvailability({
      platform: 'linux',
      bwrapPath: '/usr/bin/bwrap',
      bwrapWorks: true,
      netUnshareWorks: true,
    });
    expect(availability.available).toBe(true);
    expect(availability.backend).toBe('bubblewrap');

    const unavailable = detectSandboxAvailability({
      platform: 'darwin',
      bwrapPath: null,
      bwrapWorks: false,
      netUnshareWorks: false,
    });
    expect(unavailable.available).toBe(false);
    expect(unavailable.reason.length).toBeGreaterThan(0);
  });

  test('probeSandboxHost is exported and returns a concrete host probe', () => {
    const probe = probeSandboxHost();
    expect(typeof probe.platform).toBe('string');
    expect(typeof probe.bwrapWorks).toBe('boolean');
    expect(typeof probe.netUnshareWorks).toBe('boolean');
  });
});
