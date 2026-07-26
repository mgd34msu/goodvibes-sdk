/**
 * gateway-verb-groups-config-binding.test.ts — regression test for the
 * detached-`this` config-binding defect in
 * packages/sdk/src/platform/control-plane/routes/register-gateway-verb-groups.ts.
 *
 * The push-service `isCategoryEnabled`/`escalation` closures and the
 * tailscale `resolveWebPort`/`setPublicBaseUrl` closures used to pull
 * `configManager.get`/`.set` off the object as a value (`as unknown as
 * (...) => ...`) and call it detached from its receiver. `ConfigManager.get`/
 * `.set` (packages/sdk/src/platform/config/manager.ts) depend on `this` (they
 * call `this.resolvePath(key)`), so a genuinely detached call throws
 * `Cannot read properties of undefined (reading 'resolvePath')`.
 *
 * This test uses a REAL ConfigManager instance (never a plain-object stub —
 * a plain object has no `this` dependency and would never catch this class of
 * bug) and calls closures that mirror the file's own isCategoryEnabled /
 * escalation's `num` / resolveWebPort-read / setPublicBaseUrl exactly (they
 * are not exported, so the PRE_FIX/POST_FIX helpers below are verbatim copies
 * of, respectively, the original and the fixed source — kept in sync with
 * register-gateway-verb-groups.ts by file/line references in each comment).
 *
 * Empirical finding (verified by actually running the PRE_FIX forms below
 * against a real ConfigManager, and by temporarily reverting the source file
 * and re-running): of the four call sites the fix touches, only the
 * `escalation` closure's `const read = deps.configManager?.get as ...;
 * read?.(key)` form — where the extracted method is stored in a variable
 * before being called — actually throws. The other three
 * (isCategoryEnabled, resolveWebPort, setPublicBaseUrl) cast the same
 * expression INLINE, with no intermediate variable
 * (`(deps.configManager.get as ...)(key)` / `(...)?.(key)`), and JavaScript's
 * grouping operator does not strip a MemberExpression's reference-ness — the
 * receiver is preserved through parens and through optional chaining as long
 * as there is no separate variable assignment in between. So those three
 * were misleading, fragile, and inconsistent with this repo's real
 * `get(key as ConfigKey)` idiom (packages/sdk/src/platform/config/manager.ts:414,
 * packages/sdk/src/platform/agents/orchestrator.ts:594), but were not
 * independently reproducing a live throw. All four are still fixed the same
 * way (no casts, no detachment), and this test proves both the one real
 * regression and that the cleanup preserves correct behavior on the rest.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import type { ConfigKey } from '../packages/sdk/src/platform/config/schema.ts';

const SOURCE_PATH = join(
  import.meta.dir,
  '../packages/sdk/src/platform/control-plane/routes/register-gateway-verb-groups.ts',
);

function withRealConfigManager<T>(run: (configManager: ConfigManager) => T): T {
  const dir = join(tmpdir(), `gv-verb-groups-config-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    return run(new ConfigManager({ configDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type ConfigDep = { configManager?: Pick<ConfigManager, 'get' | 'set'> | undefined };

// --- PRE_FIX: verbatim copies of the original (broken) expressions -------

/** Mirrors the original register-gateway-verb-groups.ts:594-601 isCategoryEnabled. */
function preFixIsCategoryEnabled(deps: ConfigDep, category: 'approval' | 'needs-input' | 'other'): boolean {
  const key = category === 'approval'
    ? 'notifications.pushApproval'
    : category === 'needs-input'
      ? 'notifications.pushNeedsInput'
      : 'notifications.pushCompletion';
  return (deps.configManager?.get as unknown as ((k: string) => unknown) | undefined)?.(key) !== false;
}

/** Mirrors the original register-gateway-verb-groups.ts:606-609 escalation's `num`. */
function preFixEscalationNum(deps: ConfigDep, key: string, fallback: number): number {
  const read = deps.configManager?.get as unknown as ((k: string) => unknown) | undefined;
  const value = read?.(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Mirrors the original register-gateway-verb-groups.ts:656 resolveWebPort read. */
function preFixReadWebPort(deps: { configManager: Pick<ConfigManager, 'get' | 'set'> }): unknown {
  return (deps.configManager.get as (k: string) => unknown)('web.port');
}

/** Mirrors the original register-gateway-verb-groups.ts:659 setPublicBaseUrl. */
function preFixSetPublicBaseUrl(deps: { configManager: Pick<ConfigManager, 'get' | 'set'> }, url: string): void {
  (deps.configManager.set as (k: string, v: unknown) => unknown)('web.publicBaseUrl', url);
}

// --- POST_FIX: verbatim copies of the fixed expressions -------------------

/** Mirrors the fixed register-gateway-verb-groups.ts:594-601 isCategoryEnabled. */
function postFixIsCategoryEnabled(deps: ConfigDep, category: 'approval' | 'needs-input' | 'other'): boolean {
  const key = category === 'approval'
    ? 'notifications.pushApproval'
    : category === 'needs-input'
      ? 'notifications.pushNeedsInput'
      : 'notifications.pushCompletion';
  return deps.configManager?.get(key) !== false;
}

/** Mirrors the fixed register-gateway-verb-groups.ts:606-609 escalation's `num`. */
function postFixEscalationNum(deps: ConfigDep, key: ConfigKey, fallback: number): number {
  const value = deps.configManager?.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Mirrors the fixed register-gateway-verb-groups.ts:656 resolveWebPort read. */
function postFixReadWebPort(deps: { configManager: Pick<ConfigManager, 'get' | 'set'> }): unknown {
  return deps.configManager.get('web.port');
}

/** Mirrors the fixed register-gateway-verb-groups.ts:659 setPublicBaseUrl. */
function postFixSetPublicBaseUrl(deps: { configManager: Pick<ConfigManager, 'get' | 'set'> }, url: string): void {
  deps.configManager.set('web.publicBaseUrl', url);
}

describe('the escalation closure: the one call site that genuinely detached `this` (real regression)', () => {
  test('PRE_FIX: throws against a real ConfigManager (the detached-variable form)', () => {
    withRealConfigManager((configManager) => {
      expect(() => preFixEscalationNum({ configManager }, 'notifications.blockedEscalationGraceMs', 999)).toThrow(
        /resolvePath|undefined/,
      );
    });
  });

  test('POST_FIX: reads the real configured value without throwing', () => {
    withRealConfigManager((configManager) => {
      const value = postFixEscalationNum({ configManager }, 'notifications.blockedEscalationGraceMs', -1);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
  });
});

describe('isCategoryEnabled / resolveWebPort / setPublicBaseUrl: inline casts, cleaned up either way', () => {
  test('PRE_FIX isCategoryEnabled does not throw (inline cast, no intermediate variable) but is still fixed', () => {
    withRealConfigManager((configManager) => {
      expect(preFixIsCategoryEnabled({ configManager }, 'approval')).toBe(true);
    });
  });

  test('POST_FIX isCategoryEnabled reads the same real (default-ON) value, cast-free', () => {
    withRealConfigManager((configManager) => {
      expect(postFixIsCategoryEnabled({ configManager }, 'approval')).toBe(true);
      expect(postFixIsCategoryEnabled({ configManager }, 'needs-input')).toBe(true);
      expect(postFixIsCategoryEnabled({ configManager }, 'other')).toBe(true);
    });
  });

  test('PRE_FIX resolveWebPort read does not throw (inline cast) but returns unknown-typed value', () => {
    withRealConfigManager((configManager) => {
      const port = preFixReadWebPort({ configManager });
      expect(typeof port).toBe('number');
      expect(port).toBeGreaterThan(0);
    });
  });

  test('POST_FIX resolveWebPort read returns the same real port value, cast-free and correctly typed', () => {
    withRealConfigManager((configManager) => {
      const port = postFixReadWebPort({ configManager });
      expect(typeof port).toBe('number');
      expect(port).toBeGreaterThan(0);
    });
  });

  test('PRE_FIX setPublicBaseUrl writes through (inline cast) but is untyped and still fixed', () => {
    withRealConfigManager((configManager) => {
      preFixSetPublicBaseUrl({ configManager }, 'https://pre-fix.example.test');
      expect(configManager.get('web.publicBaseUrl')).toBe('https://pre-fix.example.test');
    });
  });

  test('POST_FIX setPublicBaseUrl round-trips through the real ConfigManager, cast-free', () => {
    withRealConfigManager((configManager) => {
      postFixSetPublicBaseUrl({ configManager }, 'https://post-fix.example.test');
      expect(configManager.get('web.publicBaseUrl')).toBe('https://post-fix.example.test');
    });
  });
});

// The PRE_FIX/POST_FIX helpers above are copies (isCategoryEnabled/escalation
// are not exported), so they cannot by themselves catch a revert of the real
// file. This pins the actual source text so one does: a revert of any of the
// four fixed call sites back to a detached `as unknown as` cast fails here.
describe('the real source file: no detached configManager.get/.set casts remain', () => {
  const source = readFileSync(SOURCE_PATH, 'utf-8');

  test('no `as unknown as` cast wraps configManager.get or .set', () => {
    expect(source).not.toMatch(/configManager\??\.(get|set)\s+as\s+unknown\s+as/);
  });

  test('no bare `as (k: string) =>` cast wraps configManager.get or .set', () => {
    expect(source).not.toMatch(/configManager\.(get|set)\s+as\s+\(k:\s*string/);
  });

  test('the escalation closure no longer extracts .get into an intermediate variable', () => {
    expect(source).not.toMatch(/const\s+read\s*=\s*deps\.configManager/);
  });

  test('the fixed call sites are present: direct method calls with a ConfigKey-typed key', () => {
    expect(source).toContain("deps.configManager?.get(key as ConfigKey)");
    expect(source).toContain('deps.configManager.get(key as ConfigKey)');
    expect(source).toContain("deps.configManager.get('web.port')");
    expect(source).toContain("deps.configManager.set('web.publicBaseUrl', url)");
  });
});
