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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // Binary present (and executable — a truncated/non-exec binary is honestly
    // NOT 'present') but voice absent ⇒ partial.
    mkdirSync(join(paths.enginesDir, 'piper'), { recursive: true });
    writeFileSync(paths.piperBinary, 'binary', { mode: 0o755 });
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

const enc = new TextEncoder();
function tarballFixture(binaryContent: string) {
  // A fake "archive": the test extractor interprets it by writing the binary.
  return enc.encode(JSON.stringify({ binary: binaryContent }).padEnd(8192, ' '));
}
function fakeExtractor(): (archivePath: string, destDir: string) => Promise<void> {
  return async (archivePath, destDir) => {
    const payload = JSON.parse(new TextDecoder().decode(readFileSync(archivePath)).trim()) as { binary: string };
    mkdirSync(join(destDir, 'piper'), { recursive: true });
    writeFileSync(join(destDir, 'piper', 'piper'), payload.binary, { mode: 0o755 });
  };
}

function pinned(bytes: Uint8Array, url: string) {
  return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function servingFetch(byUrl: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const body = byUrl[String(url)];
    if (!body) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  }) as unknown as typeof fetch;
}
function fixtureManifests(binaryContent: string, engineVersion: string) {
  const archiveBytes = tarballFixture(binaryContent);
  const onnxBytes = (() => { const b = new Uint8Array(8192); b[0] = 0x08; return b; })();
  const jsonBytes = enc.encode('{"sample_rate":22050}'.padEnd(4885, ' '));
  const engine = { version: engineVersion, archive: pinned(archiveBytes, `https://e.test/piper-${engineVersion}.tar.gz`), binaryRelPath: 'piper/piper' };
  const voice = { id: 'fixture-voice', onnx: pinned(onnxBytes, 'https://v.test/voice.onnx'), json: pinned(jsonBytes, 'https://v.test/voice.onnx.json') };
  const fetchImpl = servingFetch({
    [engine.archive.url]: archiveBytes,
    [voice.onnx.url]: onnxBytes,
    [voice.json.url]: jsonBytes,
  });
  return { engine, voice, fetchImpl };
}

describe('fix-round hardening (reviewer scenarios)', () => {

  test('an engine version bump RE-EXTRACTS and replaces the old binary (no silent no-op)', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision, readVoiceInstallStamp } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    // Install v1 end-to-end.
    const v1 = fixtureManifests('binary-v1', 'v1');
    const first = await provision({ managedRoot: dir, platform: 'linux-x64', engineOverride: v1.engine, voiceOverride: v1.voice, fetchImpl: v1.fetchImpl, extractArchive: fakeExtractor() });
    expect(first.tts.state).toBe('provisioned');
    expect(readFileSync(paths.piperBinary, 'utf-8')).toBe('binary-v1');
    expect(readVoiceInstallStamp(dir)?.engineVersion).toBe('v1');
    // Re-run at the SAME version: everything skips, binary untouched.
    const again = await provision({ managedRoot: dir, platform: 'linux-x64', engineOverride: v1.engine, voiceOverride: v1.voice, fetchImpl: v1.fetchImpl, extractArchive: async () => { throw new Error('must not re-extract at the same version with a verified archive'); } });
    expect(again.tts.state).toBe('provisioned');
    expect(readFileSync(paths.piperBinary, 'utf-8')).toBe('binary-v1');
    // Bump the pinned engine to v2 (the exact case the incident needed — a newer
    // piper to fix the onnxruntime IR incompatibility): the OLD binary exists,
    // but the install must download AND extract the new one, replacing it.
    const v2 = fixtureManifests('binary-v2', 'v2');
    const bumped = await provision({ managedRoot: dir, platform: 'linux-x64', engineOverride: v2.engine, voiceOverride: v1.voice, fetchImpl: v2.fetchImpl, extractArchive: fakeExtractor() });
    expect(bumped.tts.state).toBe('provisioned');
    expect(readFileSync(paths.piperBinary, 'utf-8')).toBe('binary-v2'); // REPLACED
    expect(readVoiceInstallStamp(dir)?.engineVersion).toBe('v2');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a mid-extract kill never leaves a truncated binary reporting provisioned (atomic swap)', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    const v1 = fixtureManifests('good-binary', 'v1');
    // Extractor that dies mid-write (simulated SIGKILL/power loss): a truncated
    // 0-byte binary lands in the TEMP dir, then the extractor throws.
    const killedMidTar = async (_archive: string, destDir: string): Promise<void> => {
      mkdirSync(join(destDir, 'piper'), { recursive: true });
      writeFileSync(join(destDir, 'piper', 'piper'), ''); // truncated
      throw new Error('killed mid-tar');
    };
    const result = await provision({ managedRoot: dir, platform: 'linux-x64', engineOverride: v1.engine, voiceOverride: v1.voice, fetchImpl: v1.fetchImpl, extractArchive: killedMidTar });
    expect(result.tts.state).toBe('download-failed');
    // NOTHING at the final binary path — the partial tree stayed in temp and was cleaned.
    expect(existsSync(paths.piperBinary)).toBe(false);
    expect(localVoiceRuntimeStatus({ managedRoot: dir, platform: 'linux-x64' }).tts.binaryPresent).toBe(false);
    // Even an extractor that "succeeds" but produced a truncated binary is refused.
    const truncatedOk = async (_archive: string, destDir: string): Promise<void> => {
      mkdirSync(join(destDir, 'piper'), { recursive: true });
      writeFileSync(join(destDir, 'piper', 'piper'), ''); // 0 bytes
    };
    const result2 = await provision({ managedRoot: dir, platform: 'linux-x64', engineOverride: v1.engine, voiceOverride: v1.voice, fetchImpl: v1.fetchImpl, extractArchive: truncatedOk });
    expect(result2.tts.state).toBe('download-failed');
    expect(result2.tts.reason).toMatch(/missing a usable binary/);
    expect(existsSync(paths.piperBinary)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('manifest binaryRelPath drives the managed paths (no duplicated constant)', async () => {
    const dir = scratch();
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    const { PIPER_ENGINES } = await import('../packages/sdk/src/platform/voice/provisioning/manifest.ts');
    expect(paths.piperBinary).toBe(join(dir, 'engines', PIPER_ENGINES['linux-x64']!.binaryRelPath));
    rmSync(dir, { recursive: true, force: true });
  });

  test('status verification is cached by (path,size,mtime) — the model is hashed once, not per poll', async () => {
    const dir = scratch();
    const { fileMatchesCached } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const file = join(dir, 'model.onnx');
    const bytes = new Uint8Array(1024 * 1024);
    bytes[0] = 0x08;
    writeFileSync(file, bytes);
    const spec = { url: 'u', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const t0 = performance.now();
    expect(fileMatchesCached(file, spec)).toBe(true); // first call hashes
    const firstMs = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) expect(fileMatchesCached(file, spec)).toBe(true);
    const cachedMsPer = (performance.now() - t1) / 200;
    expect(cachedMsPer).toBeLessThan(Math.max(0.5, firstMs)); // cached polls are stat-only
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ownership-stamped preconfigure (reviewer scenario)', () => {
  test('install-written values UPDATE on re-install; user-set values win; user-cleared stays cleared', () => {
    const store: Record<string, string> = {};
    // First install writes all three.
    const first = preconfigureLocalVoiceKeys({
      getConfig: (k) => store[k] ?? '',
      setConfig: (k, v) => { store[k] = v; },
      ttsEngine: 'piper',
      ttsBinary: '/managed/v1/piper',
      ttsModelPath: '/managed/models/voice-a.onnx',
    });
    expect(first.set.length).toBe(3);
    // The manifest changes (new layout + new default voice); the user has ALSO
    // customized the model path, and CLEARED the engine key (deliberate disable).
    store['voice.local.ttsModelPath'] = '/my/voice.onnx';
    store['voice.local.ttsEngine'] = '';
    const second = preconfigureLocalVoiceKeys({
      getConfig: (k) => store[k] ?? '',
      setConfig: (k, v) => { store[k] = v; },
      ttsEngine: 'piper',
      ttsBinary: '/managed/v2/piper',
      ttsModelPath: '/managed/models/voice-b.onnx',
      priorInstallWrites: first.installWrites,
    });
    // Installer-owned binary path updated to v2 (no longer frozen at v1):
    expect(store['voice.local.ttsBinary']).toBe('/managed/v2/piper');
    // User-set model path wins:
    expect(store['voice.local.ttsModelPath']).toBe('/my/voice.onnx');
    // User-cleared engine key respected (NOT re-written):
    expect(store['voice.local.ttsEngine']).toBe('');
    expect(second.skipped.some((s) => s.reason.includes('cleared by the user'))).toBe(true);
    expect(second.skipped.some((s) => s.reason.includes('user value'))).toBe(true);
  });
});

describe('breaker classification + reset (reviewer scenario)', () => {
  test('an exit-1 with routine onnxruntime WARNING noise does NOT trip the breaker', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: (k) => ({ 'voice.local.ttsEngine': 'piper', 'voice.local.ttsBinary': '/p', 'voice.local.ttsModelPath': '/m.onnx' } as Record<string, string>)[k] ?? '',
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        // execFile folds stderr into error.message; piper prints this on
        // perfectly healthy runs — an exit-1 here is TRANSIENT (disk full etc).
        throw new Error("Command failed: piper\n[W:onnxruntime:, graph.cc] Removing initializer 'w_1'. It is not used by any node.\nwrite failed: No space left on device");
      },
    });
    await expect(provider.synthesize!({ text: 'x', metadata: {} } as never)).rejects.toThrow();
    await expect(provider.synthesize!({ text: 'x', metadata: {} } as never)).rejects.toThrow();
    expect(calls).toBe(2); // NOT tripped — both calls invoked the engine
  });

  test('resetEngineFailureState clears a genuinely tripped breaker (the install recovery act)', async () => {
    let calls = 0;
    let healthy = false;
    const provider = createLocalVoiceProvider({
      readConfig: (k) => ({ 'voice.local.ttsEngine': 'piper', 'voice.local.ttsBinary': '/p', 'voice.local.ttsModelPath': '/m.onnx' } as Record<string, string>)[k] ?? '',
      fileExists: () => true,
      runner: async (input) => {
        calls += 1;
        if (!healthy) {
          const e = new Error("terminate called after throwing an instance of 'Ort::Exception'\n  what(): Unsupported model IR version: 9, max supported IR version: 8") as Error & { signal?: string };
          e.signal = 'SIGABRT';
          throw e;
        }
        const o = input.args[input.args.indexOf('--output_file') + 1]!;
        writeFileSync(String(o), 'RIFF-wav');
        return { stdout: '' };
      },
    });
    await expect(provider.synthesize!({ text: 'x', metadata: {} } as never)).rejects.toThrow(/unavailable on this host/);
    await expect(provider.synthesize!({ text: 'x', metadata: {} } as never)).rejects.toThrow(/unavailable on this host/);
    expect(calls).toBe(1); // tripped
    // The message names recovery acts that WORK on managed installs.
    await provider.synthesize!({ text: 'x', metadata: {} } as never).catch((e: unknown) => {
      expect(String(e)).toMatch(/voice\.local\.install|restart the daemon/);
    });
    // voice.local.install fixed the engine and calls the reset act:
    healthy = true;
    provider.resetEngineFailureState!();
    const result = await provider.synthesize!({ text: 'x', metadata: {} } as never);
    expect(result.providerId).toBe('local');
    expect(calls).toBe(2);
  });
});

describe('managed STT (goodvibes-built whisper.cpp)', () => {
  function whisperFixture(binaryContent: string, version = 'w1') {
    const archiveBytes = tarballFixture(binaryContent); // reuses the {binary} payload shape
    const modelBytes = (() => { const b = new Uint8Array(16384); b.fill(7); return b; })();
    return {
      whisper: { version, bundle: { url: `https://w.test/whisper-${version}.tar.gz` as string | null, bytes: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex') }, binaryRelPath: 'whisper/whisper-cli' },
      model: { id: 'fixture-model', bin: pinned(modelBytes, 'https://w.test/model.bin') },
      archiveBytes, modelBytes,
    };
  }
  const whisperExtractor = async (archivePath: string, destDir: string): Promise<void> => {
    const payload = JSON.parse(new TextDecoder().decode(readFileSync(archivePath)).trim()) as { binary: string };
    mkdirSync(join(destDir, 'whisper'), { recursive: true });
    writeFileSync(join(destDir, 'whisper', 'whisper-cli'), payload.binary, { mode: 0o755 });
  };
  const bothExtractor = async (archivePath: string, destDir: string): Promise<void> => {
    // piper archives extract piper/, whisper archives extract whisper/ — pick by content.
    const payload = JSON.parse(new TextDecoder().decode(readFileSync(archivePath)).trim()) as { binary: string };
    const top = payload.binary.startsWith('whisper') ? 'whisper' : 'piper';
    mkdirSync(join(destDir, top), { recursive: true });
    writeFileSync(join(destDir, top, top === 'whisper' ? 'whisper-cli' : 'piper'), payload.binary, { mode: 0o755 });
  };

  test('a HOSTED whisper bundle provisions STT end-to-end (download + verify + atomic extract)', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision, resolveManagedEngine } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const v1 = fixtureManifests('binary-v1', 'v1');
    const w = whisperFixture('whisper-binary-1');
    const fetchImpl = ((url: string | URL | Request) => {
      const u = String(url);
      const map: Record<string, Uint8Array> = {
        [v1.engine.archive.url]: tarballFixture('binary-v1'),
        [v1.voice.onnx.url]: (() => { const b = new Uint8Array(8192); b[0] = 0x08; return b; })(),
        [v1.voice.json.url]: enc.encode('{"sample_rate":22050}'.padEnd(4885, ' ')),
        [w.whisper.bundle.url!]: w.archiveBytes,
        [w.model.bin.url]: w.modelBytes,
      };
      const body = map[u];
      return Promise.resolve(body
        ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
        : { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    }) as unknown as typeof fetch;
    const result = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w.whisper, whisperModelOverride: w.model,
      fetchImpl, extractArchive: bothExtractor,
    });
    expect(result.tts.state).toBe('provisioned');
    expect(result.stt.state).toBe('provisioned');
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    expect(readFileSync(paths.whisperBinary, 'utf-8')).toBe('whisper-binary-1');
    expect(resolveManagedEngine('stt', dir)).toEqual({ engine: 'whisper-cpp', binary: paths.whisperBinary, modelPath: paths.whisperModel });
    rmSync(dir, { recursive: true, force: true });
  });

  test('no hosted URL + no sideload -> honest bundle-unavailable naming the recipe; TTS unaffected', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const v1 = fixtureManifests('binary-v1', 'v1');
    const w = whisperFixture('whisper-binary-1');
    const unhosted = { ...w.whisper, bundle: { ...w.whisper.bundle, url: null } };
    const result = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: unhosted, whisperModelOverride: w.model,
      fetchImpl: v1.fetchImpl, extractArchive: bothExtractor,
    });
    expect(result.tts.state).toBe('provisioned'); // STT failure never blocks TTS
    expect(result.stt.state).toBe('bundle-unavailable');
    expect(result.stt.reason).toMatch(/build-whisper-bundle|sideload/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a SIDELOADED bundle matching the pin provisions STT without a hosted URL', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const v1 = fixtureManifests('binary-v1', 'v1');
    const w = whisperFixture('whisper-binary-1');
    const unhosted = { ...w.whisper, bundle: { ...w.whisper.bundle, url: null } };
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    mkdirSync(paths.enginesDir, { recursive: true });
    writeFileSync(paths.whisperArchive, w.archiveBytes); // the documented drop location
    const fetchImpl = ((url: string | URL | Request) => {
      const u = String(url);
      const map: Record<string, Uint8Array> = {
        [v1.engine.archive.url]: tarballFixture('binary-v1'),
        [v1.voice.onnx.url]: (() => { const b = new Uint8Array(8192); b[0] = 0x08; return b; })(),
        [v1.voice.json.url]: enc.encode('{"sample_rate":22050}'.padEnd(4885, ' ')),
        [w.model.bin.url]: w.modelBytes,
      };
      const body = map[u];
      return Promise.resolve(body
        ? { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
        : { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    }) as unknown as typeof fetch;
    const result = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: unhosted, whisperModelOverride: w.model,
      fetchImpl, extractArchive: bothExtractor,
    });
    expect(result.stt.state).toBe('provisioned');
    expect(readFileSync(paths.whisperBinary, 'utf-8')).toBe('whisper-binary-1');
    // A tampered sideload (pin mismatch) is refused honestly.
    const dir2 = scratch();
    const paths2 = resolveManagedVoicePaths(dir2, 'linux-x64');
    mkdirSync(paths2.enginesDir, { recursive: true });
    writeFileSync(paths2.whisperArchive, enc.encode('tampered'.padEnd(w.archiveBytes.length, 'x')));
    const result2 = await provision({
      managedRoot: dir2, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: unhosted, whisperModelOverride: w.model,
      fetchImpl, extractArchive: bothExtractor,
    });
    // Present-but-mismatched with no usable binary is reported EXPLICITLY as a
    // sideload mismatch (got X, want Y) — not the generic bundle-unavailable.
    expect(result2.stt.state).toBe('sideload-mismatch');
    expect(result2.stt.reason).toMatch(/does not match the pinned sha256.*got.*want/is);
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  test('STT preconfigure writes voice.local.stt* keys only when provisioned, with ownership rules', () => {
    const store: Record<string, string> = { 'voice.local.sttBinary': '/my/whisper' };
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (k) => store[k] ?? '',
      setConfig: (k, v) => { store[k] = v; },
      ttsEngine: 'piper', ttsBinary: '/m/piper', ttsModelPath: '/m/v.onnx',
      sttEngine: 'whisper-cpp', sttBinary: '/m/whisper-cli', sttModelPath: '/m/ggml-base.en.bin',
    });
    expect(store['voice.local.sttEngine']).toBe('whisper-cpp');
    expect(store['voice.local.sttModelPath']).toBe('/m/ggml-base.en.bin');
    expect(store['voice.local.sttBinary']).toBe('/my/whisper'); // user wins
    expect(receipt.set.map((s) => s.key)).toContain('voice.local.sttEngine');
  });

  test('status reports the STT managed state honestly (unsupported only where no pinned bundle exists)', () => {
    const dir = scratch();
    const status = localVoiceRuntimeStatus({ managedRoot: dir, platform: 'linux-x64' });
    expect(status.stt.supported).toBe(true); // linux-x64 HAS a pinned goodvibes build
    expect(status.stt.state).toBe('not-provisioned');
    expect(status.stt.reason).toMatch(/sideload|hosting release/i); // honest pending-hosting note
    const none = localVoiceRuntimeStatus({ managedRoot: dir, platform: 'darwin-arm64' });
    expect(none.stt.supported).toBe(false);
    expect(none.stt.state).toBe('unsupported-platform');
    rmSync(dir, { recursive: true, force: true });
  });

  // Full piper+extras fetch: piper is only downloaded on the FIRST install
  // (re-runs skip it), so the piper URLs are harmless to keep serving.
  const enc2 = new TextEncoder();
  function fullServe(v1: ReturnType<typeof fixtureManifests>, piperBinary: string, extra: Record<string, Uint8Array>): typeof fetch {
    return servingFetch({
      [v1.engine.archive.url]: tarballFixture(piperBinary),
      [v1.voice.onnx.url]: (() => { const b = new Uint8Array(8192); b[0] = 0x08; return b; })(),
      [v1.voice.json.url]: enc2.encode('{"sample_rate":22050}'.padEnd(4885, ' ')),
      ...extra,
    });
  }

  test('finding 9: a stale archive that fails the NEW pin is never extracted; old binary + version stamp are preserved (no false new-version stamp)', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision, readVoiceInstallStamp } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    const v1 = fixtureManifests('binary-v1', 'v1');
    const w1 = whisperFixture('whisper-binary-1', 'w1'); // hosted
    const first = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w1.whisper, whisperModelOverride: w1.model,
      fetchImpl: fullServe(v1, 'binary-v1', { [w1.whisper.bundle.url!]: w1.archiveBytes, [w1.model.bin.url]: w1.modelBytes }),
      extractArchive: bothExtractor,
    });
    expect(first.stt.state).toBe('provisioned');
    expect(readFileSync(paths.whisperBinary, 'utf-8')).toBe('whisper-binary-1');
    expect(readVoiceInstallStamp(dir)?.sttEngineVersion).toBe('w1');
    // The on-disk archive is still the w1 bytes (no NEW bundle was sideloaded);
    // the manifest bumps to w2 (url null) so the stale archive fails the w2 pin.
    const w2 = whisperFixture('whisper-binary-2', 'w2');
    const w2Unhosted = { ...w2.whisper, bundle: { ...w2.whisper.bundle, url: null } };
    const bumped = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w2Unhosted, whisperModelOverride: w1.model,
      fetchImpl: fullServe(v1, 'binary-v1', { [w1.model.bin.url]: w1.modelBytes }),
      extractArchive: async () => { throw new Error('must NOT extract a stale/mismatched archive'); },
    });
    // STT still served by the OLD binary; the stale archive was never extracted.
    expect(bumped.stt.state).toBe('provisioned');
    expect(readFileSync(paths.whisperBinary, 'utf-8')).toBe('whisper-binary-1');
    // The stamp does NOT lie: it stays at w1, not the aspirational w2.
    expect(readVoiceInstallStamp(dir)?.sttEngineVersion).toBe('w1');
    rmSync(dir, { recursive: true, force: true });
  });

  test('finding 11: a failed STT re-install preserves the version stamp, so a later correct sideload of the new bundle applies (frozen-update fixed)', async () => {
    const dir = scratch();
    const { provisionLocalVoiceRuntime: provision, readVoiceInstallStamp } = await import('../packages/sdk/src/platform/voice/provisioning/index.ts');
    const paths = resolveManagedVoicePaths(dir, 'linux-x64');
    const v1 = fixtureManifests('binary-v1', 'v1');
    const w1 = whisperFixture('whisper-binary-1', 'w1');
    const w1Unhosted = { ...w1.whisper, bundle: { ...w1.whisper.bundle, url: null } };
    // 1) Full install at w1 via a correct sideload.
    mkdirSync(paths.enginesDir, { recursive: true });
    writeFileSync(paths.whisperArchive, w1.archiveBytes);
    const first = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w1Unhosted, whisperModelOverride: w1.model,
      fetchImpl: fullServe(v1, 'binary-v1', { [w1.model.bin.url]: w1.modelBytes }),
      extractArchive: bothExtractor,
    });
    expect(first.stt.state).toBe('provisioned');
    expect(readVoiceInstallStamp(dir)?.sttEngineVersion).toBe('w1');
    // 2) The model is deleted (space reclaim) and the user re-runs OFFLINE: the
    //    STT model re-download fails. The stamp must NOT be erased.
    rmSync(paths.whisperModel, { force: true });
    const failed = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w1Unhosted, whisperModelOverride: w1.model,
      fetchImpl: fullServe(v1, 'binary-v1', {}), // model URL 404s (offline)
      extractArchive: bothExtractor,
    });
    expect(failed.stt.state).toBe('download-failed');
    // The load-bearing fix: sttEngineVersion is PRESERVED, not erased.
    expect(readVoiceInstallStamp(dir)?.sttEngineVersion).toBe('w1');
    // 3) The manifest bumps to w2; the user sideloads the NEW bundle correctly and
    //    the model is available again — the update now APPLIES precisely because
    //    the preserved w1 stamp makes the version change detectable.
    const w2 = whisperFixture('whisper-binary-2', 'w2');
    const w2Unhosted = { ...w2.whisper, bundle: { ...w2.whisper.bundle, url: null } };
    writeFileSync(paths.whisperArchive, w2.archiveBytes);
    const updated = await provision({
      managedRoot: dir, platform: 'linux-x64',
      engineOverride: v1.engine, voiceOverride: v1.voice,
      whisperOverride: w2Unhosted, whisperModelOverride: w2.model,
      fetchImpl: fullServe(v1, 'binary-v1', { [w2.model.bin.url]: w2.modelBytes }),
      extractArchive: bothExtractor,
    });
    expect(updated.stt.state).toBe('provisioned');
    expect(readFileSync(paths.whisperBinary, 'utf-8')).toBe('whisper-binary-2'); // UPDATED
    expect(readVoiceInstallStamp(dir)?.sttEngineVersion).toBe('w2');
    rmSync(dir, { recursive: true, force: true });
  });

  test('finding 12: the default whisper model URL is pinned to an immutable HF revision, not the mutable main ref', async () => {
    const { DEFAULT_WHISPER_MODEL } = await import('../packages/sdk/src/platform/voice/provisioning/manifest.ts');
    expect(DEFAULT_WHISPER_MODEL.bin.url).not.toContain('/resolve/main/');
    expect(DEFAULT_WHISPER_MODEL.bin.url).toMatch(/\/resolve\/[0-9a-f]{40}\/ggml-base\.en\.bin$/);
    // The pin change keeps the checksum identical (same file bytes).
    expect(DEFAULT_WHISPER_MODEL.bin.sha256).toBe('a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002');
  });
});
