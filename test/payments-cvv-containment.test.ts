/**
 * payments-cvv-containment.test.ts
 *
 * The card verification value is stored. That is the owner's ruling, "we save
 * the cvv, full stop. it is 100% needed for autonomous action", and it is
 * settled (docs/decisions/2026-07-27-the-cvv-is-stored.md).
 *
 * This file is the reason that decision is safe to live with. Storing the value
 * is only defensible if it goes exactly one place and appears nowhere else, so
 * every containment claim in docs/payments.md §9.5 is asserted here against real
 * output rather than described in prose.
 *
 * The value used throughout is an obviously-fake fixture. No real card material
 * appears in this repository.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../packages/sdk/src/platform/config/secrets.js';
import { daemonSecretKeyFor } from '../packages/sdk/src/platform/config/daemon-secret-keys.js';
import {
  DAEMON_OWNED_CONFIG_PREFIXES,
  isDaemonOwnedConfigKey,
} from '../packages/sdk/src/platform/config/config-ownership.js';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../packages/sdk/src/platform/config/schema.js';

/** Obviously fake fixtures. No real card material appears in this repository. */
const FIXTURE_PAN = '4242424242424242';
/** A longer fixture too: a 3-digit string could collide by chance in a dump. */
const FIXTURE_CVV_SENTINEL = 'CVV-SENTINEL-9f3a1c7d';

function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-cvv-containment-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every file under a directory, as text. Used to search real on-disk output. */
function readAllFiles(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else out.push({ path: full, text: readFileSync(full, 'latin1') });
    }
  };
  walk(root);
  return out;
}

describe('the stored CVV goes to the daemon secret tier and nowhere else', () => {
  test('the payments prefix is daemon-owned, so a surface cannot write it to its own tier', () => {
    expect(DAEMON_OWNED_CONFIG_PREFIXES).toContain('payments.');
    expect(isDaemonOwnedConfigKey('payments.cards.card-1.cvv')).toBe(true);
    expect(isDaemonOwnedConfigKey('payments.budget.dailyItem')).toBe(true);
  });

  test('the secret key is derived from the config path, not hand-picked', () => {
    const key = daemonSecretKeyFor('payments.cards.card-1.cvv');
    expect(key).toBeTruthy();
    expect(key).toContain('PAYMENTS');
    expect(key).toContain('CVV');
    // The derived key names the field; it never embeds the value.
    expect(key).not.toContain(FIXTURE_CVV_SENTINEL);
  });

  test('the config SCHEMA has no key that holds card material', () => {
    // Every payment key a surface can set is a budget, a window, a preference or
    // an id. If a `cvv`/`pan`/`number` key ever appears in CONFIG_SCHEMA it means
    // card material acquired a config home, which is the failure this asserts
    // against.
    const cardMaterialKeys = CONFIG_SCHEMA.filter((setting) =>
      /\b(cvv|cvc|pan|cardNumber|securityCode)\b/i.test(setting.key),
    );
    expect(cardMaterialKeys.map((setting) => setting.key)).toEqual([]);
  });

  test('the default config contains no card material field', () => {
    const serialized = JSON.stringify(DEFAULT_CONFIG);
    expect(serialized).not.toMatch(/"cvv"/i);
    expect(serialized).not.toMatch(/"pan"/i);
  });
});

describe('the stored CVV is not readable as plaintext on disk', () => {
  test('the encrypted store does not contain the value in the clear', async () => {
    const home = tempHome();
    try {
      const manager = new SecretsManager({
        projectRoot: join(home.dir, 'project'),
        globalHome: home.dir,
        surfaceRoot: 'goodvibes',
        policy: 'require_secure',
      });
      await manager.set(daemonSecretKeyFor('payments.cards.card-1.cvv'), FIXTURE_CVV_SENTINEL, {
        scope: 'daemon',
        medium: 'secure',
      });

      const files = readAllFiles(home.dir);
      expect(files.length).toBeGreaterThan(0);
      const leaking = files.filter((file) => file.text.includes(FIXTURE_CVV_SENTINEL));
      expect(leaking.map((file) => file.path)).toEqual([]);
    } finally {
      home.cleanup();
    }
  });

  test('the value is still retrievable by the daemon that stored it', async () => {
    const home = tempHome();
    try {
      const manager = new SecretsManager({
        projectRoot: join(home.dir, 'project'),
        globalHome: home.dir,
        surfaceRoot: 'goodvibes',
        policy: 'require_secure',
      });
      const key = daemonSecretKeyFor('payments.cards.card-1.cvv');
      await manager.set(key, FIXTURE_CVV_SENTINEL, { scope: 'daemon', medium: 'secure' });
      // Containment that also made the value unusable would be a broken feature,
      // not a safe one. Autonomous action needs this read to work.
      expect(await manager.get(key)).toBe(FIXTURE_CVV_SENTINEL);
    } finally {
      home.cleanup();
    }
  });
});

describe('the payments module never emits card material', () => {
  test('no payments source file logs, renders, or serializes a cvv field', async () => {
    const { Glob } = await import('bun');
    const glob = new Glob('*.ts');
    const dir = new URL('../packages/sdk/src/platform/payments/', import.meta.url).pathname;

    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: dir })) {
      // entry-surface.ts is the one module that must NAME these fields: it
      // decides whether an inbound message looks like card details so it can
      // refuse it. It reports which SHAPE matched and never the matching text,
      // asserted separately in payments-card-entry-surface.test.ts, including
      // that the refusal contains no four-digit run at all. Exempting it by name
      // keeps this rule meaningful for every other module rather than widening
      // the pattern until it stops catching anything.
      if (file === 'entry-surface.ts') continue;
      // The three modules that exist to HANDLE card material, added with
      // `payments.checkout.fillCard`. The capability has to type the card into a
      // checkout or it cannot buy anything, so exactly these three name the
      // fields, and each is held to a stricter rule in the test below, which
      // asserts none of them can log, serialize or echo what it holds. The
      // exemption is by name rather than by widening the pattern, so every
      // decision module in this directory is still covered by the rule above.
      if (
        file === 'card-material.ts'
        || file === 'card-redaction.ts'
        || file === 'fill-card.ts'
        // Names the card FIELD NAMES in a refusal ("name one of: number,
        // expiry, ... cvv"), and holds no material itself, it delegates to
        // fill-card.ts. Held to the same stricter rule below regardless.
        || file === 'payments-gateway-service.ts'
      ) continue;
      const text = await Bun.file(`${dir}${file}`).text();
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The decision modules deal in amounts, tiers and last4. None of them has
      // any business holding a verification value or a full number.
      if (/\b(cvv|cvc|securityCode|cardNumber|\bpan\b)\b/i.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('the modules that DO hold card material cannot log, serialize or echo it', async () => {
    const dir = new URL('../packages/sdk/src/platform/payments/', import.meta.url).pathname;
    for (const file of ['card-material.ts', 'card-redaction.ts', 'fill-card.ts', 'payments-gateway-service.ts']) {
      const text = await Bun.file(`${dir}${file}`).text();
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Nothing writes it anywhere a human or a file could read it later.
      expect(code).not.toMatch(/console\./);
      expect(code).not.toMatch(/\blog(ger)?\s*\./i);
      expect(code).not.toMatch(/JSON\.stringify/);
      // Nothing throws it. An error message is a read path exactly like a
      // response field, and fill-card.ts discards the driver's own error for
      // precisely this reason.
      expect(code).not.toMatch(/throw new [A-Za-z]*Error\([^)]*\$\{\s*(value|material\.)/);
    }

    // And the result type has no property that could carry a value at all.
    const fillSource = await Bun.file(`${dir}fill-card.ts`).text();
    const resultBlock = /export interface FillCardResult \{([\s\S]*?)\}/.exec(fillSource)?.[1] ?? '';
    expect(resultBlock).not.toBe('');
    expect(resultBlock).toMatch(/filled: readonly CardFieldName\[\]/);
    expect(resultBlock).not.toMatch(/\bvalue\b|\bnumber:\s*string|\bcvv\b/);
  });

  test('the facts a prompt is rendered from carry last4 only', async () => {
    const source = await Bun.file(
      new URL('../packages/sdk/src/platform/payments/message.ts', import.meta.url),
    ).text();
    // PurchaseFacts is the complete set of fields a prompt can show. It exposes
    // cardLast4 and nothing else about the instrument.
    expect(source).toContain('cardLast4');
    expect(source).not.toMatch(/\bcvv\b/i);
  });

  test('card metadata exposed to surfaces has no material fields', async () => {
    const source = await Bun.file(
      new URL('../packages/sdk/src/platform/payments/types.ts', import.meta.url),
    ).text();
    const metadataBlock = source.slice(
      source.indexOf('export interface CardMetadata'),
      source.indexOf('export interface PostalAddress'),
    );
    expect(metadataBlock).toContain('last4');
    expect(metadataBlock).not.toMatch(/\bcvv\b/i);
    expect(metadataBlock).not.toMatch(/\bpan\b/i);
  });
});

describe('the prompt trade-off is stated where the switch is flipped', () => {
  test('the shared warning names the actual consequence', async () => {
    const { CVV_PROMPT_TRADEOFF_WARNING } = await import(
      '../packages/sdk/src/platform/payments/index.js'
    );
    // Surfaces render this string rather than writing their own, so the wording
    // cannot drift between the TUI, the agent and the webui.
    expect(CVV_PROMPT_TRADEOFF_WARNING).toContain('disables unattended purchasing');
    expect(CVV_PROMPT_TRADEOFF_WARNING).toContain('within budget');
  });

  test('the setting ships both values with stored as the default', () => {
    const setting = CONFIG_SCHEMA.find((entry) => entry.key === 'payments.cvvHandling');
    expect(setting).toBeDefined();
    expect(setting?.default).toBe('stored');
    expect(setting?.enumValues).toEqual(['stored', 'prompt']);
  });
});

describe('the fixture values themselves are never committed anywhere real', () => {
  test('the fake PAN appears only in tests', async () => {
    const { Glob } = await import('bun');
    const glob = new Glob('**/*.ts');
    const dir = new URL('../packages/sdk/src/platform/', import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: dir })) {
      const text = await Bun.file(`${dir}${file}`).text();
      if (text.includes(FIXTURE_PAN)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
