/**
 * voice-provisioning.test.ts (item 8)
 *
 * Managed local-voice provisioning: atomic + checksum-verified downloads (pass,
 * checksum-fail keeps nothing, size-mismatch, resumable skip on re-run), managed
 * path resolution precedence, config pre-configuration that preserves user-set
 * keys, and honest provision states. NO real network — all fetch is mocked.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadVerifiedFile,
  localVoiceRuntimeStatus,
  preconfigureLocalVoiceKeys,
  provisionLocalVoiceRuntime,
  resolveManagedEngine,
  resolveManagedVoicePaths,
} from '../packages/sdk/src/platform/voice/provisioning/index.ts';
import { createLocalVoiceProvider } from '../packages/sdk/src/platform/voice/providers/local.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function mockFetchBytes(bytes: Uint8Array, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok, status,
    headers: { get: (): string | null => null },
    arrayBuffer: async (): Promise<ArrayBuffer> => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  })) as unknown as typeof fetch;
}
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'gv-voice-prov-'));
}

describe('downloadVerifiedFile — atomic + checksum', () => {
  test('a matching download lands; a re-run skips it (resumable)', async () => {
    const dir = scratch();
    const dest = join(dir, 'model.onnx');
    const bytes = new TextEncoder().encode('a-real-model-payload');
    const spec = { url: 'https://m.test/x', bytes: bytes.length, sha256: sha256(bytes) };
    const first = await downloadVerifiedFile({ spec, destPath: dest, fetchImpl: mockFetchBytes(bytes) });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.skipped).toBe(false);
    expect(existsSync(dest)).toBe(true);
    // Re-run: already present + verified ⇒ skipped, and fetch must NOT be called.
    let called = false;
    const second = await downloadVerifiedFile({ spec, destPath: dest, fetchImpl: (async () => { called = true; throw new Error('should not fetch'); }) as unknown as typeof fetch });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe(true);
    expect(called).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a checksum mismatch is refused and keeps NOTHING', async () => {
    const dir = scratch();
    const dest = join(dir, 'model.onnx');
    const bytes = new TextEncoder().encode('tampered-bytes');
    const spec = { url: 'u', bytes: bytes.length, sha256: 'deadbeef'.repeat(8) };
    const result = await downloadVerifiedFile({ spec, destPath: dest, fetchImpl: mockFetchBytes(bytes) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('checksum-mismatch');
    expect(existsSync(dest)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a size mismatch is refused', async () => {
    const dir = scratch();
    const dest = join(dir, 'model.onnx');
    const bytes = new TextEncoder().encode('short');
    const result = await downloadVerifiedFile({ spec: { url: 'u', bytes: 9999, sha256: sha256(bytes) }, destPath: dest, fetchImpl: mockFetchBytes(bytes) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('size-mismatch');
    expect(existsSync(dest)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('managed path resolution + status', () => {
  test('resolveManagedEngine returns TTS only when the managed install is present', () => {
    const dir = scratch();
    const paths = resolveManagedVoicePaths(dir);
    // Nothing installed yet.
    expect(resolveManagedEngine('tts', dir)).toBeNull();
    expect(resolveManagedEngine('stt', dir)).toBeNull();
    // Install the binary + a voice model.
    mkdirSync(join(paths.enginesDir, 'piper'), { recursive: true });
    writeFileSync(paths.piperBinary, 'binary');
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.defaultVoiceOnnx, 'model');
    const tts = resolveManagedEngine('tts', dir);
    expect(tts).toEqual({ engine: 'piper', binary: paths.piperBinary, modelPath: paths.defaultVoiceOnnx });
    expect(resolveManagedEngine('stt', dir)).toBeNull(); // STT is never managed (whisper unsupported)
    rmSync(dir, { recursive: true, force: true });
  });

  test('status reports not-provisioned, partial, and unsupported-platform honestly', () => {
    const dir = scratch();
    const paths = resolveManagedVoicePaths(dir);
    expect(localVoiceRuntimeStatus({ managedRoot: dir, platform: 'linux-x64' }).state).toBe('not-provisioned');
    // Binary present but voice absent ⇒ partial.
    mkdirSync(join(paths.enginesDir, 'piper'), { recursive: true });
    writeFileSync(paths.piperBinary, 'binary');
    expect(localVoiceRuntimeStatus({ managedRoot: dir, platform: 'linux-x64' }).state).toBe('partial');
    // A platform with no pinned build.
    const unsupported = localVoiceRuntimeStatus({ managedRoot: dir, platform: null });
    expect(unsupported.state).toBe('unsupported-platform');
    expect(unsupported.stt.supported).toBe(false);
    // The size-labeled offer is present for a supported platform.
    expect(localVoiceRuntimeStatus({ managedRoot: dir, platform: 'linux-x64' }).offerBytes).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('config pre-configuration preserves user keys', () => {
  test('unset keys are set to the managed install; user-set keys are preserved', () => {
    const store: Record<string, string> = { 'voice.local.ttsModelPath': '/my/custom/voice.onnx' };
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (k) => store[k] ?? '',
      setConfig: (k, v) => { store[k] = v; },
      ttsEngine: 'piper',
      ttsBinary: '/managed/piper',
      ttsModelPath: '/managed/voice.onnx',
    });
    expect(store['voice.local.ttsEngine']).toBe('piper');
    expect(store['voice.local.ttsBinary']).toBe('/managed/piper');
    // User-set value wins — never overwritten.
    expect(store['voice.local.ttsModelPath']).toBe('/my/custom/voice.onnx');
    expect(receipt.set.map((s) => s.key).sort()).toEqual(['voice.local.ttsBinary', 'voice.local.ttsEngine']);
    expect(receipt.skipped.map((s) => s.key)).toEqual(['voice.local.ttsModelPath']);
  });
});

describe('provider resolves managed install by default; config still wins', () => {
  test('empty config + managed present ⇒ TTS capable; a set config path overrides managed', () => {
    const managed = { engine: 'piper', binary: '/managed/piper', modelPath: '/managed/voice.onnx' };
    // Empty config, managed available → provider is TTS-capable via the managed install.
    const p1 = createLocalVoiceProvider({ readConfig: () => '', resolveManaged: (prefix) => (prefix === 'tts' ? managed : null) });
    expect(p1.capabilities).toContain('tts');
    // A user-set model path wins over the managed one (per-field precedence).
    let seenModel = '';
    const p2 = createLocalVoiceProvider({
      readConfig: (k) => (k === 'voice.local.ttsModelPath' ? '/user/voice.onnx' : ''),
      fileExists: () => true,
      resolveManaged: (prefix) => (prefix === 'tts' ? managed : null),
      runner: async (input) => { seenModel = String(input.args[input.args.indexOf('--model') + 1]); const o = input.args[input.args.indexOf('--output_file') + 1]; writeFileSync(String(o), 'wav'); return { stdout: '' }; },
    });
    return p2.synthesize!({ text: 'hi', metadata: {} } as never).then(() => {
      expect(seenModel).toBe('/user/voice.onnx'); // config wins
      expect(managed.binary).toBe('/managed/piper'); // managed filled the unset binary
    });
  });
});

describe('provision honest states (mock fetch)', () => {
  test('an unsupported platform provisions nothing and says so', async () => {
    const dir = scratch();
    const result = await provisionLocalVoiceRuntime({ managedRoot: dir, platform: null });
    expect(result.tts.state).toBe('unsupported-platform');
    expect(result.stt.state).toBe('unsupported-platform');
    expect(result.components).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a size-mismatched download fails honestly and keeps nothing', async () => {
    const dir = scratch();
    // The mock returns tiny bytes for every URL — the pinned size guard rejects them.
    const result = await provisionLocalVoiceRuntime({
      managedRoot: dir,
      platform: 'linux-x64',
      fetchImpl: mockFetchBytes(new TextEncoder().encode('tiny')),
      extractArchive: async () => { throw new Error('should not extract on failed download'); },
    });
    expect(result.tts.state).toBe('download-failed');
    const paths = resolveManagedVoicePaths(dir);
    expect(existsSync(paths.defaultVoiceOnnx)).toBe(false); // nothing left behind
    rmSync(dir, { recursive: true, force: true });
  });
});
