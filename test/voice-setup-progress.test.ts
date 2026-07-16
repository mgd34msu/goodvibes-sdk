/**
 * voice-setup-progress.test.ts — live install progress through the status read.
 *
 * voice.local.install is plain request/response, so during a ~209MB provision a
 * surface can only render busy→receipt UNLESS status carries the active run's
 * progress. These tests drive the real createVoiceSetupService (real
 * single-flight, real tracker, real provisioner) with a gated mock fetch and
 * prove: status DURING an install reports advancing per-component progress
 * (phase + byte sizes where known), a second concurrent install caller joins
 * the same in-flight run, and status AFTER completion drops the section.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceSetupService } from '../packages/sdk/src/platform/runtime/voice-setup.ts';
import { provisionLocalVoiceRuntime } from '../packages/sdk/src/platform/voice/provisioning/index.ts';

const enc = new TextEncoder();

function pinned(bytes: Uint8Array, url: string) {
  return { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function tarballFixture(binaryContent: string): Uint8Array {
  return enc.encode(JSON.stringify({ binary: binaryContent }).padEnd(8192, ' '));
}
/** Extracts piper/ or whisper/ trees based on the fixture payload. */
const bothExtractor = async (archivePath: string, destDir: string): Promise<void> => {
  const payload = JSON.parse(new TextDecoder().decode(readFileSync(archivePath)).trim()) as { binary: string };
  const top = payload.binary.startsWith('whisper') ? 'whisper' : 'piper';
  mkdirSync(join(destDir, top), { recursive: true });
  writeFileSync(join(destDir, top, top === 'whisper' ? 'whisper-cli' : 'piper'), payload.binary, { mode: 0o755 });
};

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('voice.local.status carries live install progress (polling shape)', () => {
  test('status during an in-flight install reports advancing per-component progress; second caller joins; completion drops the section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-voice-progress-'));
    try {
      // Fixture manifests: piper engine + voice, hosted whisper bundle + model.
      const engineBytes = tarballFixture('binary-v1');
      const onnxBytes = (() => { const b = new Uint8Array(8192); b[0] = 0x08; return b; })();
      const jsonBytes = enc.encode('{"sample_rate":22050}'.padEnd(4885, ' '));
      const whisperBytes = tarballFixture('whisper-binary-1');
      const modelBytes = (() => { const b = new Uint8Array(16384); b.fill(7); return b; })();
      const engine = { version: 'v1', archive: pinned(engineBytes, 'https://e.test/piper.tar.gz'), binaryRelPath: 'piper/piper' };
      const voice = { id: 'fixture-voice', onnx: pinned(onnxBytes, 'https://v.test/voice.onnx'), json: pinned(jsonBytes, 'https://v.test/voice.onnx.json') };
      const whisper = { version: 'w1', bundle: { ...pinned(whisperBytes, 'https://w.test/whisper.tar.gz'), url: 'https://w.test/whisper.tar.gz' as string | null }, binaryRelPath: 'whisper/whisper-cli' };
      const model = { id: 'fixture-model', bin: pinned(modelBytes, 'https://w.test/model.bin') };

      // GATED fetch: every URL serves immediately EXCEPT the whisper model —
      // it blocks until the test releases it, holding the install mid-flight
      // at a deterministic point (piper fully landed, model still downloading).
      let releaseModel: (() => void) | undefined;
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      const byUrl: Record<string, Uint8Array> = {
        [engine.archive.url]: engineBytes,
        [voice.onnx.url]: onnxBytes,
        [voice.json.url]: jsonBytes,
        [whisper.bundle.url!]: whisperBytes,
        [model.bin.url]: modelBytes,
      };
      const fetchImpl = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u === model.bin.url) await modelGate;
        const body = byUrl[u];
        if (!body) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
      }) as unknown as typeof fetch;

      const configStore: Record<string, string> = {};
      let breakerResets = 0;
      const service = createVoiceSetupService({
        managedVoiceRoot: dir,
        getConfig: (k) => configStore[k] ?? '',
        setConfig: (k, v) => { configStore[k] = v; },
        resetLocalEngineFailureState: () => { breakerResets += 1; },
        admitExpensiveWork: () => ({ allowed: true }),
        provision: (options) => provisionLocalVoiceRuntime({
          ...options,
          platform: 'linux-x64',
          engineOverride: engine,
          voiceOverride: voice,
          whisperOverride: whisper,
          whisperModelOverride: model,
          fetchImpl,
          extractArchive: bothExtractor,
        }),
        readStatus: () => ({
          platform: 'linux-x64', state: 'not-provisioned',
          tts: { engine: 'piper', binaryPresent: false, voicePresent: false, binaryPath: '', modelPath: '' },
          stt: { engine: 'whisper-cpp', supported: true, state: 'not-provisioned', binaryPresent: false, modelPresent: false, binaryPath: '', modelPath: '' },
          offerBytes: 1,
        }),
      });

      // Before any install: no section.
      expect(service.status().installInProgress).toBeUndefined();

      // Kick off the install and a SECOND concurrent caller.
      const first = service.install();
      const second = service.install();

      // Poll status until the install is mid-flight at the gated model download.
      const componentsNow = (): ReadonlyArray<{ component: string; phase: string; bytesTotal?: number | undefined; bytesDone?: number | undefined }> =>
        service.status().installInProgress?.components ?? [];
      await waitFor(
        () => componentsNow().some((c) => c.component === 'whisper-model' && c.phase === 'download'),
        'whisper-model download phase visible in status',
      );

      const snapshot = service.status().installInProgress!;
      expect(snapshot.startedAt).toBeGreaterThan(0);
      const byComponent = new Map(snapshot.components.map((c) => [c.component, c]));
      // Progress ADVANCED through the earlier components (done, byte-labeled).
      expect(byComponent.get('piper-voice-onnx')?.phase).toBe('done');
      expect(byComponent.get('piper-voice-onnx')?.bytesTotal).toBe(onnxBytes.length);
      expect(byComponent.get('piper-voice-onnx')?.bytesDone).toBe(onnxBytes.length);
      // The piper engine's LATEST phase is extract — and the byte totals from
      // its download events persist through the byte-less extract event.
      expect(byComponent.get('piper-engine')?.phase).toBe('extract');
      expect(byComponent.get('piper-engine')?.bytesTotal).toBe(engineBytes.length);
      // The gated component is honestly mid-download: total known, done not.
      expect(byComponent.get('whisper-model')?.phase).toBe('download');
      expect(byComponent.get('whisper-model')?.bytesTotal).toBe(modelBytes.length);
      expect(byComponent.get('whisper-model')?.bytesDone).toBeUndefined();
      // The regular status fields still ride alongside the section.
      expect(service.status().state).toBe('not-provisioned');

      // Release the gate; both callers resolve to the SAME single-flight run.
      releaseModel!();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b); // literally the same in-flight result
      expect(a.provisioned).toBe(true);
      expect(a.stt.state).toBe('provisioned');
      expect(breakerResets).toBe(1);

      // After completion the section is DROPPED — absent, not stale.
      expect(service.status().installInProgress).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed install still drops the section (no stale progress after error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-voice-progress-fail-'));
    try {
      const service = createVoiceSetupService({
        managedVoiceRoot: dir,
        getConfig: () => '',
        setConfig: () => {},
        resetLocalEngineFailureState: () => {},
        admitExpensiveWork: () => ({ allowed: true }),
        // Every download 404s — the provision fails fast.
        provision: (options) => provisionLocalVoiceRuntime({
          ...options,
          platform: 'linux-x64',
          fetchImpl: (async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch,
        }),
      });
      const result = await service.install();
      expect(result.provisioned).toBe(false);
      expect(service.status().installInProgress).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the critical-tier admission refusal never begins a progress window', async () => {
    const service = createVoiceSetupService({
      managedVoiceRoot: '/nonexistent',
      getConfig: () => '',
      setConfig: () => {},
      resetLocalEngineFailureState: () => {},
      admitExpensiveWork: () => ({ allowed: false, reason: 'refused: test pressure' }),
    });
    await expect(service.install()).rejects.toThrow(/refused: test pressure/);
    expect(service.status().installInProgress).toBeUndefined();
  });
});
