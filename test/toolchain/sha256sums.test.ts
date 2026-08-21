import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSha256Sums, verifySha256Sums, parseSha256Manifest } from '@pellux/goodvibes-toolchain';

const BIN = resolve(import.meta.dir, '../../packages/toolchain/src/bin/sha256sums.ts');
const stagingDirs: string[] = [];

function staging(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sha256sums-'));
  stagingDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function runBin(cwd: string, args: readonly string[]) {
  const res = spawnSync('bun', [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

afterAll(() => {
  for (const dir of stagingDirs) rmSync(dir, { recursive: true, force: true });
});

const files: Record<string, Uint8Array> = {
  'goodvibes-linux-x64': new TextEncoder().encode('binary-a'),
  'goodvibes-daemon-linux-x64': new TextEncoder().encode('binary-b'),
};
const readBytes = (p: string): Uint8Array | null => files[p] ?? null;
// Deterministic fake hash for the test (length-prefixed content marker).
const fakeHash = (b: Uint8Array): string => `${b.length}`.padStart(64, '0');

describe('sha256sums', () => {
  test('generates a two-space manifest for present assets', () => {
    const result = generateSha256Sums(
      [{ name: 'goodvibes-linux-x64', path: 'goodvibes-linux-x64' }, { name: 'goodvibes-daemon-linux-x64', path: 'goodvibes-daemon-linux-x64' }],
      readBytes,
      fakeHash,
    );
    expect(result.ok).toBe(true);
    expect(result.manifest).toContain('  goodvibes-linux-x64');
    expect(parseSha256Manifest(result.manifest).size).toBe(2);
  });

  test('hard-fails when an asset is missing', () => {
    const result = generateSha256Sums([{ name: 'absent', path: 'absent' }], readBytes, fakeHash);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('absent');
    expect(result.manifest).toBe('');
  });

  test('verify detects a mismatched hash', () => {
    const manifest = 'deadbeef'.repeat(8) + '  goodvibes-linux-x64\n';
    const realHash = (b: Uint8Array): string => Buffer.from(b).toString('hex').padStart(64, '0').slice(0, 64);
    const result = verifySha256Sums(manifest, readBytes, realHash);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toContain('goodvibes-linux-x64');
  });
});

// The bin's two halves have to agree on what a recorded name means. --out
// records bare basenames; --verify used to resolve them against the process
// cwd, so the exact layout --out produces (manifest beside its assets) failed
// to verify from anywhere but that directory.
describe('sha256sums CLI round-trip', () => {
  test('a manifest written over a staging dir verifies from that dir', () => {
    const dir = staging({ 'goodvibes-linux-x64': 'binary-a', 'goodvibes-daemon-linux-x64': 'binary-b' });
    const generated = runBin(dir, ['--out', 'SHA256SUMS.txt', 'goodvibes-linux-x64', 'goodvibes-daemon-linux-x64']);
    expect(generated.status).toBe(0);

    const manifest = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8');
    const recorded = [...parseSha256Manifest(manifest).keys()].sort();
    expect(recorded).toEqual(['goodvibes-daemon-linux-x64', 'goodvibes-linux-x64']);

    expect(runBin(dir, ['--verify', 'SHA256SUMS.txt']).status).toBe(0);
  });

  test('verification resolves recorded names against the MANIFEST directory, not the cwd', () => {
    const dir = staging({ 'goodvibes-linux-x64': 'binary-a' });
    expect(runBin(dir, ['--out', 'SHA256SUMS.txt', 'goodvibes-linux-x64']).status).toBe(0);
    // Run from an unrelated cwd holding none of the assets: the pre-fix bin
    // reported every recorded name missing here.
    const elsewhere = staging({});
    const verified = runBin(elsewhere, ['--verify', join(dir, 'SHA256SUMS.txt')]);
    expect(verified.status).toBe(0);
    expect(verified.output).toContain('all assets verified');
  });

  test('a tampered asset fails verification and is named', () => {
    const dir = staging({ 'goodvibes-linux-x64': 'binary-a', 'goodvibes-daemon-linux-x64': 'binary-b' });
    expect(runBin(dir, ['--out', 'SHA256SUMS.txt', 'goodvibes-linux-x64', 'goodvibes-daemon-linux-x64']).status).toBe(0);
    writeFileSync(join(dir, 'goodvibes-daemon-linux-x64'), 'binary-b-tampered');

    const verified = runBin(dir, ['--verify', 'SHA256SUMS.txt']);
    expect(verified.status).toBe(1);
    expect(verified.output).toContain('mismatched goodvibes-daemon-linux-x64');
  });

  test('a deleted asset fails verification and is named', () => {
    const dir = staging({ 'goodvibes-linux-x64': 'binary-a' });
    expect(runBin(dir, ['--out', 'SHA256SUMS.txt', 'goodvibes-linux-x64']).status).toBe(0);
    rmSync(join(dir, 'goodvibes-linux-x64'));

    const verified = runBin(dir, ['--verify', 'SHA256SUMS.txt']);
    expect(verified.status).toBe(1);
    expect(verified.output).toContain('missing goodvibes-linux-x64');
  });

  test('assets in a subdirectory are recorded by basename, so the release download set verifies', () => {
    // The release shape: generate from dist/, upload the flat asset set beside
    // the manifest, verify where they land.
    const dir = staging({ 'dist/goodvibes-linux-x64': 'binary-a' });
    expect(runBin(dir, ['--out', 'dist/SHA256SUMS.txt', 'dist/goodvibes-linux-x64']).status).toBe(0);
    const manifest = readFileSync(join(dir, 'dist/SHA256SUMS.txt'), 'utf8');
    expect([...parseSha256Manifest(manifest).keys()]).toEqual(['goodvibes-linux-x64']);
    expect(runBin(dir, ['--verify', 'dist/SHA256SUMS.txt']).status).toBe(0);
  });

  test('two assets sharing a basename are refused rather than written as ambiguous lines', () => {
    const dir = staging({ 'a/goodvibes-linux-x64': 'from-a', 'b/goodvibes-linux-x64': 'from-b' });
    const generated = runBin(dir, ['--out', 'SHA256SUMS.txt', 'a/goodvibes-linux-x64', 'b/goodvibes-linux-x64']);
    expect(generated.status).toBe(1);
    expect(generated.output).toContain('share a basename');
  });
});
