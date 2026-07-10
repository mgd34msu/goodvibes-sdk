/**
 * relay-security.test.ts
 *
 * Unit coverage for the relay security posture: the WebAuthn step-up policy
 * decision, the mutating-verb signal, the via-relay request predicate, and the
 * LAN certificate minter's openssl orchestration (driven through injected
 * runner/fs so it is deterministic and needs no real openssl on the host).
 */
import { describe, expect, test } from 'bun:test';
import { isRelayTunneledRequest, RELAY_VIA_HEADER } from '../packages/daemon-sdk/src/relay-registration.js';
import {
  evaluateStepUp,
  isMutatingMethod,
} from '../packages/sdk/src/platform/relay/step-up-policy.js';
import {
  mintLanCertificate,
  type LanCertCommandRunner,
  type LanCertFs,
} from '../packages/sdk/src/platform/relay/lan-cert.js';

describe('step-up policy decision', () => {
  test('only bites on mutating relay calls when required', () => {
    // Non-relay, or read-only, or requirement off → always allow.
    expect(evaluateStepUp({ viaRelay: false, mutating: true, requireStepUp: true, assertionVerified: null }).allow).toBe(true);
    expect(evaluateStepUp({ viaRelay: true, mutating: false, requireStepUp: true, assertionVerified: null }).allow).toBe(true);
    expect(evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: false, assertionVerified: null }).allow).toBe(true);
  });

  test('fails closed when required and no verifier is wired', () => {
    const d = evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: true, assertionVerified: null });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.code).toBe('step-up-verifier-unavailable');
  });

  test('denies when the assertion is absent or invalid, allows when genuinely verified', () => {
    const denied = evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: true, assertionVerified: false });
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.code).toBe('step-up-required');
    expect(evaluateStepUp({ viaRelay: true, mutating: true, requireStepUp: true, assertionVerified: true }).allow).toBe(true);
  });

  test('mutating-verb signal matches the catalog read/write split', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(isMutatingMethod(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isMutatingMethod(m)).toBe(true);
  });
});

describe('via-relay request predicate', () => {
  test('detects the relay marker header', () => {
    expect(isRelayTunneledRequest(new Request('http://d/', { headers: { [RELAY_VIA_HEADER]: '1' } }))).toBe(true);
    expect(isRelayTunneledRequest(new Request('http://d/'))).toBe(false);
  });
});

describe('LAN certificate minting orchestration', () => {
  function fakes() {
    const calls: string[][] = [];
    const writes = new Map<string, string>();
    const present = new Set<string>();
    const runner: LanCertCommandRunner = {
      run: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const fs: LanCertFs = {
      mkdirp: async () => {},
      writeFile: async (path, data) => {
        writes.set(path, data);
      },
      exists: async (path) => present.has(path),
    };
    return { calls, writes, present, runner, fs };
  }

  test('issues the CA + leaf openssl sequence with a SAN config and returns servable paths', async () => {
    const f = fakes();
    const result = await mintLanCertificate(
      { dir: '/home/daemon/tls', hostnames: ['daemon.local', 'studio.lan'], ipAddresses: ['127.0.0.1', '192.168.1.9'] },
      { runner: f.runner, fs: f.fs },
    );
    // Four openssl invocations: CA self-sign, leaf key, CSR, CA-signed leaf.
    expect(f.calls.length).toBe(4);
    expect(f.calls[0]).toContain('req');
    expect(f.calls[0]).toContain('-x509');
    expect(f.calls[3]).toContain('x509');
    expect(f.calls[3]).toContain('-CAcreateserial');
    // SAN config carries every hostname and IP.
    const san = f.writes.get('/home/daemon/tls/lan-san.cnf') ?? '';
    expect(san).toContain('DNS.1 = daemon.local');
    expect(san).toContain('DNS.2 = studio.lan');
    expect(san).toContain('IP.1 = 127.0.0.1');
    expect(san).toContain('IP.2 = 192.168.1.9');
    // Servable paths + the CA the user must trust.
    expect(result.caCertPath).toBe('/home/daemon/tls/ca-cert.pem');
    expect(result.certPath).toBe('/home/daemon/tls/lan-cert.pem');
    expect(result.keyPath).toBe('/home/daemon/tls/lan-key.pem');
    expect(result.reused).toBe(false);
  });

  test('reuses existing material without invoking openssl', async () => {
    const f = fakes();
    f.present.add('/home/daemon/tls/ca-cert.pem');
    f.present.add('/home/daemon/tls/lan-cert.pem');
    f.present.add('/home/daemon/tls/lan-key.pem');
    const result = await mintLanCertificate({ dir: '/home/daemon/tls' }, { runner: f.runner, fs: f.fs });
    expect(result.reused).toBe(true);
    expect(f.calls.length).toBe(0);
  });

  test('surfaces an openssl failure as a clear error', async () => {
    const f = fakes();
    const failing: LanCertCommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) };
    await expect(mintLanCertificate({ dir: '/home/daemon/tls' }, { runner: failing, fs: f.fs })).rejects.toThrow(/openssl/);
  });
});
