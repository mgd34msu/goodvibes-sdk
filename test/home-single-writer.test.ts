/**
 * home-single-writer.test.ts — one live process per surface home.
 *
 * The defect: a turn forked a SECOND agent onto the home a live agent was
 * already running out of, and two writers over one `.goodvibes/agent/` tree
 * produced a process-killing temp-file race and a session left marked "active"
 * by a writer that no longer existed. Nothing refused, because a home had no
 * notion of an owner.
 *
 * The guard has to refuse the real case and — just as load-bearing — must NOT
 * refuse on a stale record, because a boot guard that stops a product from
 * starting for a reason that is not true is worse than the defect. Both
 * directions are pinned here, and every seam (pid, identity, clock) is injected
 * so nothing spawns a process.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  claimSurfaceHome,
  decideHomeClaim,
  surfaceHomeClaimPath,
  SurfaceHomeInUseError,
  type HomeOwnerClaim,
} from '../packages/sdk/src/platform/runtime/home-single-writer.ts';
import { createClientRuntimeServices } from '../packages/sdk/src/platform/runtime/client-services.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';

const AGENT = '/usr/local/bin/goodvibes-agent --daemon';

const claim = (over: Partial<HomeOwnerClaim> = {}): HomeOwnerClaim => ({
  pid: 4242,
  claimedAt: 1_700_000_000_000,
  identity: AGENT,
  ...over,
});

// ── The decision ────────────────────────────────────────────────────────────

describe('decideHomeClaim', () => {
  test('an unclaimed home is claimed', () => {
    expect(decideHomeClaim({ existing: null, pid: 1, identity: AGENT, holderIdentityNow: null }))
      .toEqual({ outcome: 'claim' });
  });

  test('a live process with the same identity refuses, naming the holding pid', () => {
    const decision = decideHomeClaim(
      { existing: claim(), pid: 99, identity: AGENT, holderIdentityNow: AGENT },
      { surfaceRoot: 'agent', homePath: '/home/x/.goodvibes/agent/owner.json' },
    );
    expect(decision.outcome).toBe('refuse');
    if (decision.outcome !== 'refuse') throw new Error('unreachable');
    expect(decision.holderPid).toBe(4242);
    expect(decision.message).toContain('4242');
    expect(decision.message).toContain('/home/x/.goodvibes/agent/owner.json');
    expect(decision.message).toContain('already owned by a live process');
  });

  test('our OWN claim is already-held, not a refusal — re-entrancy is not contention', () => {
    expect(decideHomeClaim({ existing: claim({ pid: 77 }), pid: 77, identity: AGENT, holderIdentityNow: AGENT }))
      .toEqual({ outcome: 'already-held' });
  });

  test('a dead holder is not a holder: the claim is taken', () => {
    expect(decideHomeClaim({ existing: claim(), pid: 99, identity: AGENT, holderIdentityNow: null }))
      .toEqual({ outcome: 'claim' });
  });

  test('a RECYCLED pid — alive, but now some other program — does not refuse a boot', () => {
    expect(decideHomeClaim({
      existing: claim(),
      pid: 99,
      identity: AGENT,
      holderIdentityNow: '/usr/bin/firefox',
    })).toEqual({ outcome: 'claim' });
  });
});

// ── The filesystem shell ────────────────────────────────────────────────────

describe('claimSurfaceHome', () => {
  const roots: string[] = [];
  const newHome = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'gv-home-claim-'));
    roots.push(root);
    return root;
  };

  test('claiming an empty home writes an owner record', () => {
    const home = newHome();
    const held = claimSurfaceHome({
      homeDirectory: home, surfaceRoot: 'agent', pid: 500, identity: AGENT, now: () => 123,
    });
    const onDisk = JSON.parse(readFileSync(held.path, 'utf-8')) as HomeOwnerClaim;
    expect(onDisk).toEqual({ pid: 500, claimedAt: 123, identity: AGENT });
    held.release();
    expect(existsSync(held.path)).toBe(false);
  });

  test('a second LIVE process on the same home throws, naming the pid', () => {
    const home = newHome();
    claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'agent', pid: 500, identity: AGENT });
    let thrown: unknown;
    try {
      claimSurfaceHome({
        homeDirectory: home,
        surfaceRoot: 'agent',
        pid: 501,
        identity: AGENT,
        identityOf: (pid) => (pid === 500 ? AGENT : null),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurfaceHomeInUseError);
    expect((thrown as SurfaceHomeInUseError).holderPid).toBe(500);
    expect((thrown as Error).message).toContain('500');
  });

  test('a DEAD holder does not block a boot', () => {
    const home = newHome();
    claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'agent', pid: 500, identity: AGENT });
    const second = claimSurfaceHome({
      homeDirectory: home, surfaceRoot: 'agent', pid: 501, identity: AGENT, identityOf: () => null,
    });
    const onDisk = JSON.parse(readFileSync(second.path, 'utf-8')) as HomeOwnerClaim;
    expect(onDisk.pid).toBe(501);
  });

  test('a different surface is a different home — the agent does not block the terminal', () => {
    const home = newHome();
    claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'agent', pid: 500, identity: AGENT });
    const tui = claimSurfaceHome({
      homeDirectory: home, surfaceRoot: 'tui', pid: 501, identity: AGENT, identityOf: () => AGENT,
    });
    expect(tui.path).toBe(surfaceHomeClaimPath(home, 'tui'));
  });

  test('several holders in ONE process: the record survives until the last release', () => {
    const home = newHome();
    const first = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'daemon', pid: 900, identity: AGENT });
    const second = claimSurfaceHome({ homeDirectory: home, surfaceRoot: 'daemon', pid: 900, identity: AGENT });
    first.release();
    expect(existsSync(first.path)).toBe(true);
    second.release();
    expect(existsSync(first.path)).toBe(false);
  });

  test('an unreadable owner record is not a holder', () => {
    const home = newHome();
    const path = surfaceHomeClaimPath(home, 'agent');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json at all', 'utf-8');
    const held = claimSurfaceHome({
      homeDirectory: home, surfaceRoot: 'agent', pid: 501, identity: AGENT, identityOf: () => AGENT,
    });
    expect((JSON.parse(readFileSync(held.path, 'utf-8')) as HomeOwnerClaim).pid).toBe(501);
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});

// ── The composition wiring ──────────────────────────────────────────────────

/**
 * The guard existing and a composition USING it are two claims. A wiring that
 * silently stops claiming would leave every unit test above passing.
 */
describe('createClientRuntimeServices homeSingleWriter', () => {
  const roots: string[] = [];
  const compose = (homeSingleWriter?: 'claim' | 'off') => {
    const home = mkdtempSync(join(tmpdir(), 'gv-home-claim-wiring-'));
    roots.push(home);
    const workingDir = join(home, 'work');
    mkdirSync(workingDir, { recursive: true });
    const services = createClientRuntimeServices({
      configManager: new ConfigManager({
        surfaceRoot: 'agent', configDir: join(home, 'cfg'), workingDir, homeDir: home,
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'agent',
      workingDir,
      homeDirectory: home,
      requestApproval: async () => ({ approved: true }),
      modelDiscovery: 'skip',
      ...(homeSingleWriter === undefined ? {} : { homeSingleWriter }),
    });
    return { home, services, claimPath: surfaceHomeClaimPath(home, 'agent') };
  };

  test("'claim' records this process as the home's owner, and dispose gives it back", () => {
    const { services, claimPath } = compose('claim');
    const record = JSON.parse(readFileSync(claimPath, 'utf-8')) as HomeOwnerClaim;
    expect(record.pid).toBe(process.pid);
    services.dispose();
    expect(existsSync(claimPath)).toBe(false);
  });

  test('the default claims nothing — a terminal is legitimately run twice', () => {
    const { services, claimPath } = compose();
    expect(existsSync(claimPath)).toBe(false);
    services.dispose();
  });

  test('cleanup', () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    expect(roots).toHaveLength(0);
  });
});
