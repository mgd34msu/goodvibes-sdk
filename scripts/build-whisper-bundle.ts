/**
 * build-whisper-bundle.ts — reproducibly build the goodvibes whisper.cpp
 * engine bundle whose pin lives in
 * packages/sdk/src/platform/voice/provisioning/manifest.ts (WHISPER_ENGINES).
 *
 * whisper.cpp publishes no official prebuilt binaries, so goodvibes builds
 * them: pinned source tag, static ggml (BUILD_SHARED_LIBS=OFF), portable
 * codegen (GGML_NATIVE=OFF), stripped whisper-cli, packed as
 * goodvibes-whisper-cpp-<version>-<platform>.tar.gz containing
 * `whisper/whisper-cli`.
 *
 * Usage:  bun scripts/build-whisper-bundle.ts [--version 1.8.2] [--out DIR]
 *
 * Output: the bundle tarball plus its byte count and sha256 — paste these into
 * the platform's WHISPER_ENGINES entry, and upload the tarball wherever the
 * release hosts artifacts, then set `bundle.url`. Until it is hosted, the SAME
 * artifact installs via sideload: drop it at <managedRoot>/engines/whisper.tar.gz
 * and run voice.local.install (the pin verifies it either way).
 *
 * Requires: cmake, a C/C++ toolchain, tar, curl. Bails honestly when missing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

function platformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  throw new Error(`unsupported build platform ${p}/${a}`);
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (exit ${code})`);
}

const version = arg('version', '1.8.2');
const outDir = resolve(arg('out', '.tmp/whisper-bundle'));
const platform = platformKey();

for (const tool of ['cmake', 'tar', 'curl']) {
  if (!Bun.which(tool)) {
    console.error(`[build-whisper-bundle] '${tool}' is required but not on PATH.`);
    process.exit(1);
  }
}

const work = mkdtempSync(join(tmpdir(), 'gv-whisper-build-'));
try {
  console.log(`[build-whisper-bundle] whisper.cpp v${version} for ${platform}`);
  const srcTar = join(work, 'src.tar.gz');
  await run(['curl', '-sL', '-o', srcTar, `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${version}.tar.gz`]);
  await run(['tar', '-xzf', srcTar, '-C', work]);
  const srcDir = join(work, `whisper.cpp-${version}`);
  if (!existsSync(srcDir)) throw new Error(`source directory missing after extract: ${srcDir}`);

  await run(['cmake', '-B', 'build',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',   // static ggml/whisper — the bundle is one binary
    '-DGGML_NATIVE=OFF',         // portable codegen, no -march=native
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
  ], srcDir);
  await run(['cmake', '--build', 'build', '-j', String(navigator.hardwareConcurrency ?? 4), '--target', 'whisper-cli'], srcDir);

  const binary = join(srcDir, 'build', 'bin', 'whisper-cli');
  if (!existsSync(binary) || statSync(binary).size === 0) throw new Error('whisper-cli did not build');
  if (Bun.which('strip')) await run(['strip', binary]);

  const stage = join(work, 'stage', 'whisper');
  mkdirSync(stage, { recursive: true });
  await run(['cp', binary, join(stage, 'whisper-cli')]);

  mkdirSync(outDir, { recursive: true });
  const bundleName = `goodvibes-whisper-cpp-${version}-${platform}.tar.gz`;
  const bundlePath = join(outDir, bundleName);
  rmSync(bundlePath, { force: true });
  await run(['tar', '-czf', bundlePath, '-C', join(work, 'stage'), 'whisper']);

  const bytes = statSync(bundlePath).size;
  const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  console.log('');
  console.log(`[build-whisper-bundle] bundle: ${bundlePath}`);
  console.log(`[build-whisper-bundle] bytes:  ${bytes}`);
  console.log(`[build-whisper-bundle] sha256: ${sha256}`);
  console.log('');
  console.log('WHISPER_ENGINES manifest entry:');
  console.log(JSON.stringify({
    [platform]: {
      version,
      bundle: { url: '<hosted artifact URL, or null while sideload-only>', bytes, sha256 },
      binaryRelPath: 'whisper/whisper-cli',
    },
  }, null, 2));
  console.log('');
  console.log(`Sideload install: cp ${bundleName} <managedRoot>/engines/whisper.tar.gz && run voice.local.install`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
