/**
 * host-binding-resolver.test.ts
 *
 * Bind-honesty seams: resolveHostBinding has an explicit posture for
 * unrecognized hostMode values (safe local fallback + recognized:false —
 * consumers no longer invent their own handling), and the web endpoint has a
 * real binding resolver (validated port with explicit fallback semantics)
 * that surface-registry / announcements / the tailscale verb anchor to.
 */
import { describe, expect, test } from 'bun:test';
import { resolveHostBinding, resolveWebBinding, resolveWebPort } from '../packages/sdk/src/platform/daemon/host-resolver.ts';

describe('resolveHostBinding unrecognized-value posture', () => {
  test('recognized modes resolve exactly as before, flagged recognized', () => {
    expect(resolveHostBinding('local', '', 0, 'controlPlane')).toEqual({ host: '127.0.0.1', port: 3421, recognized: true, effectiveMode: 'local' });
    expect(resolveHostBinding('network', '', 4000, 'web')).toEqual({ host: '0.0.0.0', port: 4000, recognized: true, effectiveMode: 'network' });
    expect(resolveHostBinding('custom', '192.168.1.5', 8080, 'httpListener')).toEqual({ host: '192.168.1.5', port: 8080, recognized: true, effectiveMode: 'custom' });
  });

  test('case/padding variants of real modes are recognized, not fall-through', () => {
    expect(resolveHostBinding('Network', '', 0, 'web')).toEqual({ host: '0.0.0.0', port: 3423, recognized: true, effectiveMode: 'network' });
    expect(resolveHostBinding('  local ', '', 0, 'web').recognized).toBe(true);
    expect(resolveHostBinding('CUSTOM', 'h', 1, 'web').effectiveMode).toBe('custom');
  });

  test("the exact fixture strings — 'LAN', '' — fall back to the SAFE local posture with recognized:false", () => {
    for (const raw of ['LAN', '', 'lan ', 'public', '0.0.0.0']) {
      const binding = resolveHostBinding(raw, '10.0.0.1', 5000, 'controlPlane');
      expect(binding.recognized, `"${raw}" must be flagged unrecognized`).toBe(false);
      expect(binding.effectiveMode).toBe('local');
      expect(binding.host).toBe('127.0.0.1'); // NEVER accidentally network-exposed
      expect(binding.port).toBe(5000); // a valid port still applies
    }
  });

  test('invalid ports fall back to the server-type default', () => {
    expect(resolveHostBinding('local', '', Number.NaN, 'web').port).toBe(3423);
    expect(resolveHostBinding('local', '', 0, 'controlPlane').port).toBe(3421);
    expect(resolveHostBinding('local', '', -5, 'httpListener').port).toBe(3422);
    expect(resolveHostBinding('local', '', 70000, 'web').port).toBe(3423);
    expect(resolveHostBinding('local', '', 3.5, 'web').port).toBe(3423);
  });
});

describe('resolveWebBinding — the web endpoint truth', () => {
  test('valid stored values resolve recognized', () => {
    expect(resolveWebBinding({ hostMode: 'network', host: '', port: 8080 })).toEqual({ host: '0.0.0.0', port: 8080, recognized: true, effectiveMode: 'network' });
  });

  test('0, NaN, and non-numeric ports fall back to 3423 (never 0/NaN passthrough) and flag recognized:false', () => {
    for (const raw of [0, Number.NaN, 'not-a-port', '', undefined, -1, 99999]) {
      const binding = resolveWebBinding({ port: raw });
      expect(binding.port, `port ${String(raw)} must fall back`).toBe(3423);
      if (raw !== undefined) expect(binding.recognized).toBe(raw === undefined);
    }
    // undefined = simply unset — the documented default applies and stays honest.
    expect(resolveWebBinding({}).port).toBe(3423);
  });

  test('an unrecognized web hostMode is flagged and binds local', () => {
    const binding = resolveWebBinding({ hostMode: 'LAN', host: '10.1.1.1', port: 3423 });
    expect(binding.recognized).toBe(false);
    expect(binding.host).toBe('127.0.0.1');
  });

  test('resolveWebPort convenience matches the binding resolver', () => {
    expect(resolveWebPort('3423')).toBe(3423);
    expect(resolveWebPort(4001)).toBe(4001);
    expect(resolveWebPort(Number.NaN)).toBe(3423);
    expect(resolveWebPort(0)).toBe(3423);
  });
});
