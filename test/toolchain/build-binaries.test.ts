import { describe, expect, test } from 'bun:test';
import { resolveTargets, buildCompileArgs, runBuildBinaries, captureLogger, type BuildConfig } from '@pellux/goodvibes-toolchain';
import { scriptedExec } from './_helpers.ts';

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
