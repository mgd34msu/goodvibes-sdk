// build-speexdsp-wasm.ts
//
// Rebuilds the WebAssembly module behind `voice.wake.noiseSuppression: "speex"`
// and regenerates the source file that embeds it.
//
//   bun scripts/build-speexdsp-wasm.ts          download, verify, compile, regenerate
//   bun scripts/build-speexdsp-wasm.ts --check  verify the committed artifact only
//
// This is NOT a gate and nothing runs it automatically. The artifact is
// committed, so a checkout builds and tests without a C toolchain; --check
// exists for a human who wants to confirm the committed base64 still matches its
// recorded sha256, which test/voice-noise-suppression.test.ts also asserts.
//
// Everything the build depends on is pinned: the upstream tarball by sha256, the
// compiler and sysroot by version (recorded into the generated file, and printed
// on every run so a drift is visible rather than silent). See
// native/speexdsp-wasm/README.md.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_DIR = join(REPO_ROOT, 'native/speexdsp-wasm');
const GENERATED = join(
  REPO_ROOT,
  'packages/sdk/src/platform/voice/capture/vendor/speexdsp-wasm.ts',
);
const WORK_DIR = join(REPO_ROOT, '.tmp/speexdsp-wasm');

/** Upstream, pinned by version AND by the checksum of the exact archive. */
const UPSTREAM = {
  version: '1.2.1',
  url: 'https://github.com/xiph/speexdsp/archive/refs/tags/SpeexDSP-1.2.1.tar.gz',
  sha256: 'd17ca363654556a4ff1d02cc13d9eb1fc5a8642c90b40bd54ce266c3807b91a7',
  /** Directory the archive expands to. */
  root: 'speexdsp-SpeexDSP-1.2.1',
} as const;

/** Only the preprocessor and the FFT it needs. No echo canceller, no resampler. */
const UPSTREAM_SOURCES = [
  'libspeexdsp/preprocess.c',
  'libspeexdsp/filterbank.c',
  'libspeexdsp/fftwrap.c',
  'libspeexdsp/smallft.c',
] as const;

const WASI_SYSROOT = process.env.WASI_SYSROOT ?? '/usr/share/wasi-sysroot';

const CLANG_FLAGS = [
  '--target=wasm32-wasip1',
  '-Oz',
  '-DFLOATING_POINT',
  '-DUSE_SMALLFT',
  '-DOS_SUPPORT_CUSTOM',
  '-DEXPORT=',
  '-nostartfiles',
  '-Wl,--no-entry',
  '-Wl,--strip-all',
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkCommitted(): void {
  if (!existsSync(GENERATED)) {
    console.error(`ERROR: ${GENERATED} does not exist. Run this script without --check.`);
    process.exit(1);
  }
  const source = readFileSync(GENERATED, 'utf8');
  const base64 = /SPEEXDSP_WASM_BASE64 = '([A-Za-z0-9+/=]+)'/.exec(source)?.[1];
  const recordedSha = /SPEEXDSP_WASM_SHA256 = '([0-9a-f]{64})'/.exec(source)?.[1];
  const recordedBytes = /SPEEXDSP_WASM_BYTES = (\d+)/.exec(source)?.[1];
  if (base64 === undefined || recordedSha === undefined || recordedBytes === undefined) {
    console.error('ERROR: the generated file does not carry a base64 blob, a sha256 and a byte count.');
    process.exit(1);
  }
  const bytes = Buffer.from(base64, 'base64');
  const actualSha = sha256(bytes);
  const ok = actualSha === recordedSha && bytes.length === Number(recordedBytes);
  console.log(`committed module: ${bytes.length} bytes, sha256 ${actualSha}`);
  console.log(`recorded        : ${recordedBytes} bytes, sha256 ${recordedSha}`);
  if (!ok) {
    console.error('ERROR: the committed base64 does not match what the file records about it.');
    process.exit(1);
  }
  console.log('OK: the committed artifact matches its recorded checksum and size.');
}

function toolVersion(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: 'utf8' }).split('\n')[0]?.trim() ?? 'unknown';
}

/** Best-effort package version, so a non-Arch host still builds and just says so. */
function pacmanVersion(pkg: string): string {
  try {
    return execFileSync('pacman', ['-Q', pkg], { encoding: 'utf8' }).trim().split(/\s+/)[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function download(): string {
  mkdirSync(WORK_DIR, { recursive: true });
  const archive = join(WORK_DIR, `speexdsp-${UPSTREAM.version}.tar.gz`);
  if (!existsSync(archive)) {
    console.log(`downloading ${UPSTREAM.url}`);
    execFileSync('curl', ['-sSL', '--max-time', '300', '-o', archive, UPSTREAM.url], { stdio: 'inherit' });
  }
  const actual = sha256(readFileSync(archive));
  if (actual !== UPSTREAM.sha256) {
    console.error(`ERROR: archive sha256 ${actual} does not match the pin ${UPSTREAM.sha256}`);
    process.exit(1);
  }
  console.log(`archive sha256 ${actual} matches the pin`);
  const sourceRoot = join(WORK_DIR, UPSTREAM.root);
  rmSync(sourceRoot, { recursive: true, force: true });
  execFileSync('tar', ['xzf', archive, '-C', WORK_DIR], { stdio: 'inherit' });
  return sourceRoot;
}

/**
 * Assemble the include tree the library expects. Its configure script generates
 * `speex/speexdsp_config_types.h`; this project keeps a fixed-width version of
 * that file in native/ and copies it into place, so no autotools run is needed.
 */
function stageIncludes(sourceRoot: string): string {
  const stage = join(WORK_DIR, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'include/speex'), { recursive: true });
  for (const header of ['speex_preprocess.h', 'speexdsp_types.h', 'speex_resampler.h', 'speex_echo.h', 'speex_jitter.h', 'speex_buffer.h']) {
    const from = join(sourceRoot, 'include/speex', header);
    if (existsSync(from)) copyFileSync(from, join(stage, 'include/speex', header));
  }
  copyFileSync(join(NATIVE_DIR, 'speexdsp_config_types.h'), join(stage, 'include/speex/speexdsp_config_types.h'));
  copyFileSync(join(NATIVE_DIR, 'os_support_custom.h'), join(stage, 'os_support_custom.h'));
  return stage;
}

function compile(sourceRoot: string, stage: string): Uint8Array {
  const output = join(WORK_DIR, 'gv-speexdsp.wasm');
  rmSync(output, { force: true });
  const args = [
    ...CLANG_FLAGS,
    `--sysroot=${WASI_SYSROOT}`,
    `-I${stage}`,
    `-I${join(stage, 'include')}`,
    `-I${join(sourceRoot, 'libspeexdsp')}`,
    '-o',
    output,
    ...UPSTREAM_SOURCES.map((relative) => join(sourceRoot, relative)),
    join(NATIVE_DIR, 'gv-speex-preprocess.c'),
  ];
  console.log(`clang ${args.join(' ')}`);
  execFileSync('clang', args, { stdio: 'inherit' });
  return readFileSync(output);
}

function generate(wasm: Uint8Array, toolchain: Record<string, string>): void {
  const base64 = Buffer.from(wasm).toString('base64');
  const digest = sha256(wasm);
  const lines = [
    '/**',
    ' * speexdsp-wasm.ts — GENERATED. Do not edit by hand.',
    ' *',
    " * SpeexDSP's noise suppressor, compiled to WebAssembly and embedded as base64.",
    ' * Regenerate with `bun scripts/build-speexdsp-wasm.ts`; the build inputs, the',
    ' * toolchain pins and the attribution live in native/speexdsp-wasm/.',
    ' *',
    ' * EMBEDDED RATHER THAN DOWNLOADED, unlike the wake models. The models are',
    ' * megabytes and provisioned deliberately; this is 53 kB, and embedding it is what',
    ' * makes the setting honest — there is no state in which the filter is configured,',
    ' * unprovisioned, and therefore not running.',
    ' *',
    ' * Base64 rather than a .wasm file beside it, because the same module has to load',
    ' * in a browser tab from a bundle and in a daemon child process with no filesystem',
    ' * convention in common. A string in a module resolves identically in both.',
    ' *',
    ' * SpeexDSP is BSD 3-clause and REQUIRES its notice to travel with binary',
    ' * redistribution — which the base64 below is. That notice is',
    ' * native/speexdsp-wasm/NOTICE.txt, and SPEEXDSP_WASM.noticePath points at it.',
    ' */',
    '',
    '/** Bytes of the module, before base64. */',
    `export const SPEEXDSP_WASM_BYTES = ${wasm.length};`,
    '',
    '/** sha256 of those bytes. Asserted against the base64 below by test. */',
    `export const SPEEXDSP_WASM_SHA256 = '${digest}';`,
    '',
    '/** How the module was produced, recorded so a rebuild can be compared to it. */',
    'export const SPEEXDSP_WASM_BUILD = {',
    `  upstreamVersion: '${UPSTREAM.version}',`,
    `  upstreamUrl: '${UPSTREAM.url}',`,
    `  upstreamSha256: '${UPSTREAM.sha256}',`,
    `  compiler: '${toolchain.clang}',`,
    `  linker: '${toolchain.linker}',`,
    `  sysroot: 'wasi-libc ${toolchain.wasiLibc}',`,
    `  builtins: 'wasi-compiler-rt ${toolchain.wasiCompilerRt}',`,
    `  flags: '${CLANG_FLAGS.join(' ')}',`,
    '} as const;',
    '',
    '/** The module itself. */',
    `export const SPEEXDSP_WASM_BASE64 = '${base64}';`,
    '',
  ];
  mkdirSync(dirname(GENERATED), { recursive: true });
  writeFileSync(GENERATED, lines.join('\n'));
  console.log(`wrote ${GENERATED}`);
  console.log(`module: ${wasm.length} bytes, sha256 ${digest}, base64 ${base64.length} chars`);
}

if (process.argv.includes('--check')) {
  checkCommitted();
} else {
  const toolchain = {
    clang: toolVersion('clang', ['--version']),
    linker: toolVersion('wasm-ld', ['--version']),
    wasiLibc: pacmanVersion('wasi-libc'),
    wasiCompilerRt: pacmanVersion('wasi-compiler-rt'),
  };
  console.log(`compiler: ${toolchain.clang}`);
  console.log(`linker:   ${toolchain.linker}`);
  console.log(`sysroot:  ${WASI_SYSROOT} (wasi-libc ${toolchain.wasiLibc})`);
  if (!existsSync(WASI_SYSROOT)) {
    console.error(`ERROR: no WASI sysroot at ${WASI_SYSROOT}. Install wasi-libc + wasi-compiler-rt, or set WASI_SYSROOT.`);
    process.exit(1);
  }
  const sourceRoot = download();
  const stage = stageIncludes(sourceRoot);
  generate(compile(sourceRoot, stage), toolchain);
}
