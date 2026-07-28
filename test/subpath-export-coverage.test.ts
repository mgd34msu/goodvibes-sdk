/**
 * subpath-export-coverage.test.ts — every public platform module is reachable.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `scripts/check-subpath-api-surface.ts` iterates the package manifest's
 * `exports` map and validates the surface of each entry it finds. That makes it
 * excellent at catching a CHANGE to a declared subpath and structurally
 * incapable of catching a MISSING one: a module with no entry is not in the map,
 * so the check never looks at it and every gate stays green.
 *
 * The failure mode is invisible in the worst possible way. The source compiles,
 * the module's own tests pass, `dist/` contains the built files, api-extractor
 * is happy, and the whole suite is green — while
 * `import … from '@pellux/goodvibes-sdk/platform/<name>'` fails resolution for
 * every consumer. The capability is built, tested, shipped, and unreachable.
 *
 * It is also exactly the class the owner's standing rule is about: everything
 * gets wired, nothing left behind, nothing unconsumed. A capability that cannot
 * be imported is not shipped.
 *
 * ── Why an allowlist rather than "export everything" ──────────────────────
 *
 * Some platform modules are genuinely daemon-internal, and publishing them would
 * widen the public API surface — and its compatibility obligations — by
 * accident. So the rule is: every `src/platform/<name>/index.ts` is either in the
 * exports map or named below as a deliberate decision. Adding a module and
 * forgetting both is what fails.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_DIR = join(import.meta.dir, '..', 'packages', 'sdk');
const PLATFORM_DIR = join(PACKAGE_DIR, 'src', 'platform');

/**
 * Platform modules deliberately NOT published.
 *
 * Each is daemon-internal: it has an `index.ts` for internal composition and no
 * consumer imports it. Verified at the time of writing by grepping the TUI,
 * webui and agent worktrees — all five had zero import sites.
 *
 * Adding a name here is a decision to keep a module private. Removing one, or
 * adding its subpath to the manifest, publishes it and takes on its
 * compatibility obligations.
 */
const INTERNAL_PLATFORM_MODULES: readonly string[] = [
  'channel-profiles',
  'checkin',
  'ci-watch',
  'principals',
  'push',
];

function platformModulesWithIndex(): string[] {
  return readdirSync(PLATFORM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(PLATFORM_DIR, name, 'index.ts')))
    .sort();
}

function exportsMap(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return manifest.exports ?? {};
}

describe('every public platform module has a subpath export', () => {
  test('no module is silently unreachable', () => {
    const exported = new Set(Object.keys(exportsMap()));
    const internal = new Set(INTERNAL_PLATFORM_MODULES);
    const unreachable = platformModulesWithIndex()
      .filter((name) => !exported.has(`./platform/${name}`) && !internal.has(name));

    expect(
      unreachable,
      `these platform modules have an index.ts but no "./platform/<name>" entry in `
      + `packages/sdk/package.json exports, so consumers cannot import them: ${unreachable.join(', ')}. `
      + 'Add the subpath, or add the module to INTERNAL_PLATFORM_MODULES if it is deliberately private.',
    ).toEqual([]);
  });

  test('the internal list has no stale entries', () => {
    // A name left here after the module is deleted or published reads as a
    // decision nobody made.
    const present = new Set(platformModulesWithIndex());
    const exported = new Set(Object.keys(exportsMap()));
    const stale = INTERNAL_PLATFORM_MODULES.filter(
      (name) => !present.has(name) || exported.has(`./platform/${name}`),
    );
    expect(stale, `no longer internal or no longer present: ${stale.join(', ')}`).toEqual([]);
  });

  test('every declared subpath points at a file that will exist in the package', () => {
    // The manifest can name a types/import path that the build never produces,
    // which resolves at publish time and not before.
    const broken: string[] = [];
    for (const [subpath, value] of Object.entries(exportsMap())) {
      if (subpath === './package.json' || typeof value !== 'object' || value === null) continue;
      for (const key of ['types', 'import'] as const) {
        const target = (value as Record<string, unknown>)[key];
        if (typeof target !== 'string') continue;
        if (!existsSync(join(PACKAGE_DIR, target))) broken.push(`${subpath} -> ${key}: ${target}`);
      }
    }
    expect(broken, `exports entries pointing at missing build output: ${broken.join(', ')}`).toEqual([]);
  });

  test('the payments capability specifically is reachable', () => {
    // The module this round shipped, pinned by name so a later manifest edit
    // that drops it fails loudly rather than silently unshipping the feature.
    expect(Object.keys(exportsMap())).toContain('./platform/payments');
  });
});
