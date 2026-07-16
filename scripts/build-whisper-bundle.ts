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
 * Usage:  bun scripts/build-whisper-bundle.ts [--version 1.8.2] [--out DIR] [--tag voice-runtimes-v1]
 *
 * Hosting convention: ALL voice engine assets live at ONE append-only GitHub
 * release tag (default `voice-runtimes-v1`), each with a `<asset>.sha256`
 * sidecar next to it. Assets there are STABLE: never re-uploaded in place and
 * never renamed (a new build gets a new versioned filename). So the `bundle.url`
 * this script prints is durable, and any script/doc that references an asset
 * must be updated in the SAME commit that would move it. The tarball is
 * byte-reproducible (see the tar/gzip flags below), so a rebuild of identical
 * inputs matches the pinned sha256 and a sideloaded copy installs identically.
 *
 * Output: the bundle tarball, its byte count and sha256, the durable hosted URL,
 * and the ready-to-paste WHISPER_ENGINES entry. Upload the tarball AND a
 * `<name>.sha256` sidecar to the tag, then the url is live. Before it is hosted
 * for a platform, the SAME artifact installs via sideload: drop it at
 * <managedRoot>/engines/whisper.tar.gz and run voice.local.install.
 *
 * Requires: cmake, a C/C++ toolchain, tar, curl, gzip. Bails honestly when missing.
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
// The single append-only release tag that hosts every voice engine asset.
const tag = arg('tag', 'voice-runtimes-v1');
const releaseRepo = arg('repo', 'mgd34msu/goodvibes-sdk');
const platform = platformKey();

for (const tool of ['cmake', 'tar', 'curl', 'gzip']) {
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
  const tarPath = bundlePath.replace(/\.gz$/, '');
  rmSync(bundlePath, { force: true });
  rmSync(tarPath, { force: true });
  // BYTE-REPRODUCIBLE archive: without this the tarball embeds each run's fresh
  // file mtimes + owner/group and gzip stamps its own timestamp, so a rebuild
  // never matches the pinned sha256 and the sideload recovery instruction is
  // un-followable. Normalize entry order, mtimes, and ownership in tar, then
  // gzip with -n (no name/timestamp) — a clean rebuild of identical bytes now
  // reproduces the exact same archive sha256.
  await run(['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-cf', tarPath, '-C', join(work, 'stage'), 'whisper']);
  await run(['gzip', '-n', '-f', tarPath]); // writes tarPath + '.gz' === bundlePath

  const bytes = statSync(bundlePath).size;
  const sha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  // The .sha256 sidecar that must sit next to the asset at the release tag.
  const sidecarPath = `${bundlePath}.sha256`;
  await Bun.write(sidecarPath, `${sha256}  ${bundleName}\n`);
  const hostedUrl = `https://github.com/${releaseRepo}/releases/download/${tag}/${bundleName}`;
  console.log('');
  console.log(`[build-whisper-bundle] bundle:  ${bundlePath}`);
  console.log(`[build-whisper-bundle] sidecar: ${sidecarPath}`);
  console.log(`[build-whisper-bundle] bytes:   ${bytes}`);
  console.log(`[build-whisper-bundle] sha256:  ${sha256}`);
  console.log(`[build-whisper-bundle] hosted:  ${hostedUrl}`);
  console.log('');
  console.log('WHISPER_ENGINES manifest entry:');
  console.log(JSON.stringify({
    [platform]: {
      version,
      bundle: { url: hostedUrl, bytes, sha256 },
      binaryRelPath: 'whisper/whisper-cli',
    },
  }, null, 2));
  console.log('');
  console.log(`Upload BOTH files to the append-only '${tag}' tag (never re-upload in place / rename):`);
  console.log(`  gh release upload ${tag} ${bundlePath} ${sidecarPath} --repo ${releaseRepo}`);
  console.log(`Sideload (before hosting): cp ${bundleName} <managedRoot>/engines/whisper.tar.gz && run voice.local.install`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
