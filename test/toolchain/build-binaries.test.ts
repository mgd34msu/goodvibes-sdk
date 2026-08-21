import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTargets, buildCompileArgs, runBuildBinaries, captureLogger, resolveOptionalExternals, readDependencyManifest, type BuildConfig, type DependencyManifest } from '@pellux/goodvibes-toolchain';
import { scriptedExec, fakeFs } from './_helpers.ts';

const build: BuildConfig = {
  appEntrypoint: 'src/main.ts',
  daemonEntrypoint: 'src/daemon/cli.ts',
  outDir: 'dist',
  addonOutDir: 'dist/lib',
  prebuild: [['bun', 'run', 'scripts/prebuild.ts']],
  targets: [
    { key: 'linux-x64', bunTarget: 'bun-linux-x64', appArtifact: 'goodvibes-linux-x64', daemonArtifact: 'goodvibes-daemon-linux-x64', nativeAddonPackage: 'sqlite-vec-linux-x64', nativeAddonFile: 'vec0.so' },
    { key: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', appArtifact: 'goodvibes-macos-arm64', daemonArtifact: 'goodvibes-daemon-macos-arm64', nativeAddonPackage: 'sqlite-vec-darwin-arm64', nativeAddonFile: 'vec0.dylib' },
  ],
};

describe('build-binaries target resolution', () => {
  test('--all selects every target', () => {
    expect(resolveTargets(['--all'], build, 'linux-x64').targets).toHaveLength(2);
  });
  test('--target selects one', () => {
    const sel = resolveTargets(['--target', 'darwin-arm64'], build, 'linux-x64');
    expect(sel.targets[0]?.key).toBe('darwin-arm64');
    expect(sel.daemonOnly).toBe(false);
  });
  test('daemon- alias forces daemon-only and maps macos→darwin', () => {
    const sel = resolveTargets(['--target', 'daemon-macos-arm64'], build, 'linux-x64');
    expect(sel.targets[0]?.key).toBe('darwin-arm64');
    expect(sel.daemonOnly).toBe(true);
  });
  test('no args selects the native host target', () => {
    expect(resolveTargets([], build, 'linux-x64').targets[0]?.key).toBe('linux-x64');
  });
  test('unknown target throws', () => {
    expect(() => resolveTargets(['--target', 'plan9-x64'], build, 'linux-x64')).toThrow();
  });
});

describe('build-binaries compile args', () => {
  test('includes external for the native addon', () => {
    expect(buildCompileArgs('src/main.ts', 'bun-linux-x64', 'dist/app', ['sqlite-vec-linux-x64'])).toEqual(
      ['build', 'src/main.ts', '--compile', '--target=bun-linux-x64', '--outfile', 'dist/app', '--external', 'sqlite-vec-linux-x64'],
    );
  });
});

describe('build-binaries run', () => {
  test('builds app + daemon legs and reports success', () => {
    const calls: string[][] = [];
    const exec = scriptedExec((_c, args) => { calls.push([...args]); return { status: 0 }; });
    const outcomes = runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: false }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
    });
    expect(outcomes[0]?.ok).toBe(true);
    // prebuild + app + daemon = 3 exec calls
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('src/main.ts');
    expect(calls[2]).toContain('src/daemon/cli.ts');
  });

  test('daemon-only skips the app leg', () => {
    const calls: string[][] = [];
    const exec = scriptedExec((_c, args) => { calls.push([...args]); return { status: 0 }; });
    runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
    });
    // prebuild + daemon only
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('src/daemon/cli.ts');
  });

  test('fails the target when the addon cannot be provided', () => {
    const exec = scriptedExec(() => ({ status: 0 }));
    const outcomes = runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: false }, nativeKey: 'linux-x64',
      provideAddon: () => false, exec, logger: captureLogger(),
    });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.detail).toContain('native addon');
  });
});

// ---------------------------------------------------------------------------
// Optional dependencies decide the compile, and required ones decide the build
// ---------------------------------------------------------------------------

/**
 * The SDK declares thirty packages under `optionalDependencies` and reaches
 * every one of them through a dynamic import, so a running process without one
 * reports that feature unavailable and carries on. bun resolves a dynamic
 * import at BUNDLE time exactly as it resolves a static one, so before this the
 * compile still failed with `Could not resolve: "jsdom"` and the lazy runtime
 * resolution never got to govern. These pin the asymmetry: an absent optional
 * package is externalised, an absent required one fails the build.
 */
const manifests: DependencyManifest[] = [
  {
    name: '@pellux/goodvibes-sdk',
    path: 'node_modules/@pellux/goodvibes-sdk/package.json',
    required: ['zustand'],
    optional: ['jsdom', '@mozilla/readability', 'openai'],
  },
];

function installedExcept(absent: readonly string[]): (name: string) => boolean {
  return (name) => !absent.includes(name);
}

describe('build-binaries optional-dependency screen', () => {
  test('an absent optional package is left external so the binary still builds', () => {
    const calls: string[][] = [];
    const exec = scriptedExec((_c, args) => { calls.push([...args]); return { status: 0 }; });
    const outcomes = runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
      dependencyManifests: manifests,
      isPackageInstalled: installedExcept(['jsdom']),
    });
    expect(outcomes[0]?.ok).toBe(true);
    const compile = calls[1]!;
    expect(compile).toContain('--external');
    expect(compile).toContain('jsdom');
    // The native addon external is still there, this adds to it, never replaces it.
    expect(compile).toContain('sqlite-vec-linux-x64');
    // An optional package that IS installed stays bundled, so a normal build is unchanged.
    expect(compile).not.toContain('openai');
    expect(compile).not.toContain('@mozilla/readability');
  });

  test('several absent optional packages are all externalised, in a stable order', () => {
    const calls: string[][] = [];
    const exec = scriptedExec((_c, args) => { calls.push([...args]); return { status: 0 }; });
    runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
      dependencyManifests: manifests,
      isPackageInstalled: installedExcept(['jsdom', '@mozilla/readability', 'openai']),
    });
    expect(calls[1]).toContain('jsdom');
    expect(calls[1]).toContain('@mozilla/readability');
    expect(calls[1]).toContain('openai');
    expect(resolveOptionalExternals({ manifests, isInstalled: installedExcept(['openai', 'jsdom']) }).externals)
      .toEqual(['jsdom', 'openai']);
  });

  test('an absent REQUIRED package fails the build, by name and by manifest', () => {
    const exec = scriptedExec(() => ({ status: 0 }));
    expect(() => runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
      dependencyManifests: manifests,
      isPackageInstalled: installedExcept(['zustand']),
    })).toThrow(/zustand/);
    // Externalising it instead would trade a loud failure here for a binary
    // that dies in the field, which is the trade this whole change undoes.
    expect(() => runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
      dependencyManifests: manifests,
      isPackageInstalled: installedExcept(['zustand']),
    })).toThrow(/@pellux\/goodvibes-sdk/);
  });

  test('a package declared optional by one manifest and required by another is required', () => {
    const screened = resolveOptionalExternals({
      manifests: [
        { name: 'app', path: 'package.json', required: ['jsdom'], optional: [] },
        ...manifests,
      ],
      isInstalled: installedExcept(['jsdom']),
    });
    expect(screened.externals).not.toContain('jsdom');
    expect(screened.missingRequired.map((m) => m.packageName)).toContain('jsdom');
  });

  test('with everything installed nothing is externalised and nothing fails', () => {
    const screened = resolveOptionalExternals({ manifests, isInstalled: () => true });
    expect(screened.externals).toEqual([]);
    expect(screened.missingRequired).toEqual([]);
  });

  test('no manifests supplied means no screen — existing callers are untouched', () => {
    const calls: string[][] = [];
    const exec = scriptedExec((_c, args) => { calls.push([...args]); return { status: 0 }; });
    runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: [build.targets[0]!], daemonOnly: true }, nativeKey: 'linux-x64',
      provideAddon: () => true, exec, logger: captureLogger(),
    });
    expect(calls[1]).toEqual([
      'build', 'src/daemon/cli.ts', '--compile', '--target=bun-linux-x64',
      '--outfile', 'dist/goodvibes-daemon-linux-x64', '--external', 'sqlite-vec-linux-x64',
    ]);
  });
});

describe('build-binaries dependency manifest reading', () => {
  test('reads dependencies and optionalDependencies, skipping workspace siblings', () => {
    const fs = fakeFs({
      'package.json': JSON.stringify({
        name: '@pellux/goodvibes-tui',
        dependencies: { '@pellux/goodvibes-sdk': '1.20.0', zustand: '^5.0.12' },
        optionalDependencies: { jsdom: '^29.1.0' },
      }),
    });
    const manifest = readDependencyManifest(fs, 'package.json', 'fallback');
    expect(manifest?.name).toBe('@pellux/goodvibes-tui');
    // The SDK itself is resolved by the build root, not screened here.
    expect(manifest?.required).toEqual(['zustand']);
    expect(manifest?.optional).toEqual(['jsdom']);
  });

  test('a missing or unparseable manifest screens nothing rather than failing the build', () => {
    expect(readDependencyManifest(fakeFs({}), 'package.json', 'fallback')).toBeNull();
    expect(readDependencyManifest(fakeFs({ 'package.json': '{ not json' }), 'package.json', 'fallback')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end: the screen's externals, a real `bun build --compile`, a real run
// ---------------------------------------------------------------------------

/**
 * The unit tests above pin the argv the screen produces. This one pins that the
 * argv actually WORKS: a genuinely unresolvable optional package, screened to
 * `--external` by resolveOptionalExternals, compiled by the real bun, and run.
 *
 * Before the screen existed the same source failed at bundle time with
 * `Could not resolve: "…"` and produced no binary. The point of the change is
 * that it now produces one, and the lazy runtime resolution the SDK gained is
 * what reports the feature unavailable instead.
 *
 * The absent package is a name that does not exist anywhere, so nothing in
 * node_modules is moved or hidden and a suite running beside this one is
 * unaffected.
 */
const ABSENT_OPTIONAL = 'gv-package-that-is-not-installed';

describe('the screened compile survives a genuinely absent optional package', () => {
  const madeDirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-toolchain-externals-'));
    madeDirs.push(dir);
    return dir;
  };

  afterAll(() => {
    // Only the directories this run created, by recorded path, never a prefix
    // sweep of tmpdir(), which would delete a concurrent run's scratch.
    for (const dir of madeDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* hygiene must not fail the suite */ }
    }
  });

  test('the screen marks it external, the compile succeeds, and the binary says it is unavailable', () => {
    const screened = resolveOptionalExternals({
      manifests: [{ name: 'fixture', path: 'package.json', required: [], optional: [ABSENT_OPTIONAL] }],
      // The real resolution question, not a stub: this name resolves nowhere.
      isInstalled: (name) => { try { createRequire(import.meta.url).resolve(name); return true; } catch { return false; } },
    });
    expect(screened.externals).toEqual([ABSENT_OPTIONAL]);
    expect(screened.missingRequired).toEqual([]);

    const dir = scratch();
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, [
      "process.stdout.write('INIT_SURVIVED\\n');",
      'try {',
      `  await import('${ABSENT_OPTIONAL}');`,
      "  process.stdout.write('AVAILABLE=true\\n');",
      '} catch (error) {',
      "  process.stdout.write('AVAILABLE=false\\n');",
      '  process.stdout.write(`REASON=${error instanceof Error ? error.message : String(error)}\\n`);',
      '}',
    ].join('\n'), 'utf-8');

    const binary = join(dir, 'fixture-binary');
    const args = buildCompileArgs(entry, 'bun-linux-x64', binary, screened.externals);
    expect(args).toContain('--external');
    expect(args).toContain(ABSENT_OPTIONAL);

    const built = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf-8', timeout: 120_000 });
    // The whole point: a binary exists at all.
    expect(built.status).toBe(0);

    const run = spawnSync(binary, [], {
      cwd: dir, encoding: 'utf-8', timeout: 30_000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('INIT_SURVIVED');
    expect(run.stdout).toContain('AVAILABLE=false');
    expect(run.stdout).toContain(ABSENT_OPTIONAL);
  });

  test('without the external the same source does not compile at all — the control', () => {
    const dir = scratch();
    const entry = join(dir, 'entry.ts');
    // Static, which is the shape that shipped, and unresolvable.
    writeFileSync(entry, `import x from '${ABSENT_OPTIONAL}';\nprocess.stdout.write(String(x));\n`, 'utf-8');
    const built = spawnSync(
      process.execPath,
      buildCompileArgs(entry, 'bun-linux-x64', join(dir, 'control-binary'), []),
      { cwd: dir, encoding: 'utf-8', timeout: 120_000 },
    );
    expect(built.status).not.toBe(0);
    expect(`${built.stderr}${built.stdout}`).toContain('Could not resolve');
  });
});
