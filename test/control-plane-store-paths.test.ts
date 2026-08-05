/**
 * control-plane-store-paths.test.ts
 *
 * Pins the one resolver every control-plane store file path goes through
 * (control-plane-store-paths.ts), and proves the writers repointed at it
 * actually land under the surface-scoped directory rather than the pre-split
 * orphan `~/.goodvibes/control-plane/` a missing surface segment produces.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createShellPathService } from '../packages/sdk/src/platform/runtime/shell-paths.ts';
import { controlPlaneStorePath } from '../packages/sdk/src/platform/control-plane/control-plane-store-paths.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { installOccasions } from '../packages/sdk/src/platform/control-plane/routes/occasions-composition.ts';
import { OwnerProfileStore } from '../packages/sdk/src/platform/owner-profile/index.ts';
import { WorkspaceRegistrationManager } from '../packages/sdk/src/platform/runtime/workspace-registration.ts';

describe('controlPlaneStorePath', () => {
  test('puts the surface segment between the home root and control-plane', () => {
    const home = makeProjectTempDir('gv-cp-paths-unit');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const scoped = controlPlaneStorePath(shellPaths, 'tui', 'occasions-state.json');
    expect(scoped).toBe(join(home, '.goodvibes', 'tui', 'control-plane', 'occasions-state.json'));
  });

  test('differs from the unscoped resolveUserPath(\'control-plane\', file) path', () => {
    const home = makeProjectTempDir('gv-cp-paths-unit-diff');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const scoped = controlPlaneStorePath(shellPaths, 'tui', 'workspace-registrations.json');
    const unscoped = shellPaths.resolveUserPath('control-plane', 'workspace-registrations.json');
    expect(scoped).not.toBe(unscoped);
    expect(unscoped).toBe(join(home, '.goodvibes', 'control-plane', 'workspace-registrations.json'));
  });

  test('a blank surfaceRoot throws rather than silently producing the unscoped path', () => {
    const home = makeProjectTempDir('gv-cp-paths-unit-blank');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    expect(() => controlPlaneStorePath(shellPaths, '', 'sessions.json')).toThrow();
  });

  test('a whitespace-only surfaceRoot throws too', () => {
    const home = makeProjectTempDir('gv-cp-paths-unit-whitespace');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    expect(() => controlPlaneStorePath(shellPaths, '   ', 'sessions.json')).toThrow();
  });
});

describe('the repointed writers actually write scoped', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  test('occasions-state.json lands under <home>/.goodvibes/<surface>/control-plane/, and the unscoped directory is never created', async () => {
    const home = makeProjectTempDir('gv-cp-paths-occasions');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });
    const config = new ConfigManager({ surfaceRoot: 'daemon', configDir: join(home, 'cfg'), homeDir: home });
    const catalog = new GatewayMethodCatalog();
    // Cheap and real: the constructor does no I/O until load()/loadSync()/watch()
    // is called, none of which this test needs — only the occasions state store
    // (installOccasions's own OccasionStateStore) is under test here.
    const ownerProfile = new OwnerProfileStore({ path: join(home, 'owner-profile.md'), enabled: true });

    const composition = installOccasions(catalog, ownerProfile, {
      configManager: config,
      shellPaths,
      surfaceRoot: 'tui',
    });
    cleanups.push(() => composition.dispose());

    // A real write through the real store this composition constructed.
    await composition.state.recordAnswer({
      id: 'unit-test-occasion@2026-01-01',
      occasionId: 'unit-test-occasion',
      occurrence: '2026-01-01',
      answer: 'no',
      answeredAt: Date.now(),
    });
    await composition.state.drain();

    const expectedPath = join(home, '.goodvibes', 'tui', 'control-plane', 'occasions-state.json');
    const unscopedDir = join(home, '.goodvibes', 'control-plane');

    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(unscopedDir)).toBe(false);
  });

  test('the SHARED workspace register stays unscoped, and is the same file whatever surface root asks for it', async () => {
    // This one is deliberately NOT surface-scoped. goodvibes-agent reads and
    // writes the same file directly and the daemon reads it again for
    // checkpoint eligibility, so scoping it to whichever product composed the
    // gateway would split the register: workspaces registered from one product
    // would vanish from the other, and checkpoint eligibility would refuse
    // workspaces the operator had registered. See SHARED_UNSCOPED_STORES in
    // control-plane/pre-split-control-plane-sweep.ts, which leaves it alone for
    // the same reason.
    const home = makeProjectTempDir('gv-cp-paths-workspace');
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const shellPaths = {
      workingDirectory: project,
      homeDirectory: home,
      resolveUserPath: (...segments: string[]): string => join(home, '.goodvibes', ...segments),
    };

    const outcome = await new WorkspaceRegistrationManager({ shellPaths }).register();
    expect(outcome.registered).toBe(true);

    const sharedPath = join(home, '.goodvibes', 'control-plane', 'workspace-registrations.json');
    expect(existsSync(sharedPath)).toBe(true);
    expect(readdirSync(join(home, '.goodvibes', 'control-plane'))).toContain('workspace-registrations.json');

    // And emphatically NOT under any surface root — that is the split.
    expect(existsSync(join(home, '.goodvibes', 'tui', 'control-plane', 'workspace-registrations.json'))).toBe(false);
    expect(existsSync(join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-registrations.json'))).toBe(false);
  });

  test('two products registering workspaces see one register, not one each', async () => {
    // The regression this guards: the daemon and the agent each holding their
    // own copy, each certain the other had registered nothing.
    const home = makeProjectTempDir('gv-cp-paths-shared');
    const fromDaemon = join(home, 'projects', 'from-daemon');
    const fromAgent = join(home, 'projects', 'from-agent');
    mkdirSync(fromDaemon, { recursive: true });
    mkdirSync(fromAgent, { recursive: true });
    const shellPathsFor = (cwd: string) => ({
      workingDirectory: cwd,
      homeDirectory: home,
      resolveUserPath: (...segments: string[]): string => join(home, '.goodvibes', ...segments),
    });

    await new WorkspaceRegistrationManager({ shellPaths: shellPathsFor(fromDaemon) }).register();
    await new WorkspaceRegistrationManager({ shellPaths: shellPathsFor(fromAgent) }).register();

    const sharedPath = join(home, '.goodvibes', 'control-plane', 'workspace-registrations.json');
    const written = readFileSync(sharedPath, 'utf8');
    expect(written).toContain('from-daemon');
    expect(written).toContain('from-agent');
  });
});
