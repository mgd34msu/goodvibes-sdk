/**
 * pairing-node-cap.test.ts, `device.nodes.maxPaired` is a real cap.
 *
 * The setting presented as a live cap on paired device nodes and nothing read
 * it: pairing was unbounded, so the number in settings described nothing. It is
 * now enforced at the pairing path itself (PairingTokenManager.mint), which is
 * the single chokepoint both `pairing.tokens.create` and the QR
 * `pairing.handoff.create` go through.
 *
 * The boundary cases are the whole design, so they are the tests:
 *   - below the cap nothing changes;
 *   - at the cap a NEW device is refused, naming the setting and the count;
 *   - at the cap an ALREADY PAIRED device re-pairing is never refused;
 *   - lowering the cap below the current count unpairs nobody.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PairingLimitReachedError,
  PairingTokenManager,
} from '../packages/sdk/src/platform/pairing/pairing-token-store.ts';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gv-pairing-cap-')), 'pairing-tokens.json');
}

interface Fixture {
  readonly manager: PairingTokenManager;
  readonly cap: { value: number | undefined };
  readonly filePath: string;
  cleanup(): void;
}

function makeFixture(initialCap: number | undefined): Fixture {
  const filePath = tempFile();
  const cap: { value: number | undefined } = { value: initialCap };
  const manager = new PairingTokenManager(filePath, { maxPaired: () => cap.value });
  return {
    manager,
    cap,
    filePath,
    cleanup(): void { rmSync(join(filePath, '..'), { recursive: true, force: true }); },
  };
}

describe('device.nodes.maxPaired bounds pairing', () => {
  test('pairing below the cap behaves exactly as before', () => {
    const f = makeFixture(3);
    try {
      f.manager.mint({ name: 'Pixel' });
      f.manager.mint({ name: 'Laptop' });
      expect(f.manager.pairedCount()).toBe(2);
      expect(f.manager.list().map((token) => token.name).sort()).toEqual(['Laptop', 'Pixel']);
    } finally {
      f.cleanup();
    }
  });

  test('a new device at the cap is refused, and the refusal names the setting and the count', () => {
    const f = makeFixture(2);
    try {
      f.manager.mint({ name: 'Pixel' });
      f.manager.mint({ name: 'Laptop' });

      let thrown: unknown = null;
      try {
        f.manager.mint({ name: 'iPad' });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(PairingLimitReachedError);
      const error = thrown as PairingLimitReachedError;
      expect(error.code).toBe('DEVICE_NODES_MAX_PAIRED');
      expect(error.setting).toBe('device.nodes.maxPaired');
      expect(error.maxPaired).toBe(2);
      expect(error.pairedCount).toBe(2);
      // The message has to be actionable on its own: what refused, what the cap
      // is, how many are paired, and what to do about it.
      expect(error.message).toContain('device.nodes.maxPaired is 2');
      expect(error.message).toContain('2 devices are already paired');
      expect(error.message).toContain('Unpair a device');

      // The refused pairing left no trace.
      expect(f.manager.pairedCount()).toBe(2);
      expect(f.manager.list().some((token) => token.name === 'iPad')).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test('an already-paired node re-pairing at the cap is NOT refused', () => {
    const f = makeFixture(2);
    try {
      const pixel = f.manager.mint({ name: 'Pixel' });
      f.manager.mint({ name: 'Laptop' });
      expect(f.manager.pairedCount()).toBe(2);

      // Same device, pairing again (name match is the only identity a pairing
      // exchange carries). It supersedes its OWN record.
      const rePaired = f.manager.mint({ name: '  pixel  ' });
      expect(rePaired.token).not.toBe(pixel.token);
      expect(f.manager.pairedCount()).toBe(2);
      // The other device is untouched, re-pairing one node never unpairs another.
      expect(f.manager.list().some((token) => token.name === 'Laptop')).toBe(true);
      // The new token authenticates; the superseded one does not.
      expect(f.manager.authenticate(rePaired.token)?.name).toBe('pixel');
      expect(f.manager.authenticate(pixel.token)).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  test('lowering the cap below the current count unpairs nobody', () => {
    const f = makeFixture(4);
    try {
      const pixel = f.manager.mint({ name: 'Pixel' });
      const laptop = f.manager.mint({ name: 'Laptop' });
      const tablet = f.manager.mint({ name: 'Tablet' });
      expect(f.manager.pairedCount()).toBe(3);

      f.cap.value = 1; // the operator tightens the cap

      // Nothing is dropped, and every existing device keeps working.
      expect(f.manager.pairedCount()).toBe(3);
      expect(f.manager.authenticate(pixel.token)).not.toBeNull();
      expect(f.manager.authenticate(laptop.token)).not.toBeNull();
      expect(f.manager.authenticate(tablet.token)).not.toBeNull();

      // Only the NEXT new pairing is refused.
      expect(() => f.manager.mint({ name: 'Watch' })).toThrow(PairingLimitReachedError);
      // And an existing device can still re-pair, which is what keeps a tightened
      // cap from bricking a phone that needs a fresh token.
      expect(() => f.manager.mint({ name: 'Pixel' })).not.toThrow();
      expect(f.manager.pairedCount()).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  test('room freed by unpairing makes the next new pairing succeed again', () => {
    const f = makeFixture(2);
    try {
      const pixel = f.manager.mint({ name: 'Pixel' });
      f.manager.mint({ name: 'Laptop' });
      expect(() => f.manager.mint({ name: 'iPad' })).toThrow(PairingLimitReachedError);

      expect(f.manager.revoke(pixel.id)).toBe(true);
      expect(() => f.manager.mint({ name: 'iPad' })).not.toThrow();
      expect(f.manager.pairedCount()).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  test('the cap is re-read per pairing, so raising it takes effect without a restart', () => {
    const f = makeFixture(1);
    try {
      f.manager.mint({ name: 'Pixel' });
      expect(() => f.manager.mint({ name: 'Laptop' })).toThrow(PairingLimitReachedError);
      f.cap.value = 5;
      expect(() => f.manager.mint({ name: 'Laptop' })).not.toThrow();
      expect(f.manager.pairedCount()).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  test('a migration off the legacy shared token is exempt — it is not a new device', () => {
    const f = makeFixture(1);
    try {
      f.manager.mint({ name: 'Pixel' });
      // Refusing this would strand a working device on a credential it is being
      // asked to give up.
      const migrated = f.manager.mintForMigration({ name: 'Laptop on the shared token' });
      expect(f.manager.authenticate(migrated.token)).not.toBeNull();
      expect(f.manager.pairedCount()).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  test('a broken or absent cap never locks the owner out', () => {
    for (const broken of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = makeFixture(broken as number | undefined);
      try {
        for (let i = 0; i < 12; i++) f.manager.mint({ name: `device-${i}` });
        expect(f.manager.pairedCount()).toBe(12);
      } finally {
        f.cleanup();
      }
    }
  });

  test('a store constructed without a cap reader is unbounded, exactly as before', () => {
    const filePath = tempFile();
    const manager = new PairingTokenManager(filePath);
    try {
      for (let i = 0; i < 20; i++) manager.mint({ name: `device-${i}` });
      expect(manager.pairedCount()).toBe(20);
    } finally {
      rmSync(join(filePath, '..'), { recursive: true, force: true });
    }
  });

  test('the cap survives a reload — the count comes from the persisted store', () => {
    const filePath = tempFile();
    const cap = { value: 2 };
    try {
      const first = new PairingTokenManager(filePath, { maxPaired: () => cap.value });
      first.mint({ name: 'Pixel' });
      first.mint({ name: 'Laptop' });

      const reloaded = new PairingTokenManager(filePath, { maxPaired: () => cap.value });
      expect(reloaded.pairedCount()).toBe(2);
      expect(() => reloaded.mint({ name: 'iPad' })).toThrow(PairingLimitReachedError);
    } finally {
      rmSync(join(filePath, '..'), { recursive: true, force: true });
    }
  });
});
