/**
 * relay-security.test.ts
 *
 * Unit coverage for the relay security posture: the WebAuthn step-up policy
 * decision, the mutating-verb signal, the via-relay request predicate — and
 * the certificate-minting PROHIBITION guard: the daemon never mints
 * certificates (no self-provisioned CA, ever), so no cert-minting symbol may
 * exist on the public relay/daemon surface or in the relay source tree.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRelayTunneledRequest, RELAY_VIA_HEADER } from '../packages/daemon-sdk/src/relay-registration.js';
import {
  evaluateStepUp,
  isMutatingMethod,
} from '../packages/sdk/src/platform/relay/step-up-policy.js';
import * as relaySurface from '../packages/sdk/src/platform/relay/index.js';

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

describe('certificate-minting prohibition (the daemon never mints certificates)', () => {
  test('no cert-minting symbol exists on the public relay surface', () => {
    // The runtime export names of the relay barrel — the exact surface a
    // consumer composes from (and what ./daemon re-exports).
    const names = Object.keys(relaySurface);
    const offenders = names.filter((name) => /cert|mint|x509|openssl/i.test(name));
    expect(offenders).toEqual([]);
  });

  test('no certificate-minting module exists in the relay source tree', () => {
    const relayDir = join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'platform', 'relay');
    const files = readdirSync(relayDir);
    expect(files.some((file) => /cert/i.test(file))).toBe(false);
    // No relay source invokes openssl or self-signs anything.
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(relayDir, file), 'utf8');
      expect(source.includes('openssl'), `${file} must not orchestrate openssl`).toBe(false);
      expect(/self.signed/i.test(source), `${file} must not self-sign`).toBe(false);
    }
  });

  test('the daemon entry source exports no cert-minting name', () => {
    const daemonEntry = readFileSync(join(import.meta.dir, '..', 'packages', 'sdk', 'src', 'daemon.ts'), 'utf8');
    expect(/mint[A-Za-z]*Certificate|LanCert/i.test(daemonEntry)).toBe(false);
  });
});
