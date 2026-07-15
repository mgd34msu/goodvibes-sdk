/**
 * voice-download-and-breaker.test.ts
 *
 * Item 5: local voice model downloads are atomic + verified — a truncated .onnx
 * (Content-Length short, too small, HTML error page, or bad magic) is rejected
 * and never left at the final path.
 *
 * Item 6: when the local TTS engine hard-fails (the piper SIGABRT / onnxruntime
 * "Unsupported model IR version" abort on this host), the provider trips a
 * circuit breaker — one honest engine-unavailable state, no per-chunk crash
 * storm — and a transient timeout does NOT trip it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVoiceModel } from '../packages/sdk/src/platform/voice/model-download.ts';
import { createLocalVoiceProvider } from '../packages/sdk/src/platform/voice/providers/local.ts';
import type { VoiceSynthesisRequest } from '../packages/sdk/src/platform/voice/types.ts';

function onnxBytes(n = 8192): Uint8Array {
  const b = new Uint8Array(n);
  b[0] = 0x08; // ONNX ModelProto ir_version field tag
  return b;
}

function mockResponse(body: Uint8Array, opts: { ok?: boolean; status?: number; contentLength?: number | null } = {}): Response {
  const cl = opts.contentLength === undefined ? body.length : opts.contentLength;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string): string | null => (k.toLowerCase() === 'content-length' && cl !== null ? String(cl) : null) },
    arrayBuffer: async (): Promise<ArrayBuffer> => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  } as unknown as Response;
}
function mockFetch(resp: Response): typeof fetch {
  return (async () => resp) as unknown as typeof fetch;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-voice-dl-'));
  return dir;
}

describe('atomic voice model download (item 5)', () => {
  test('a complete, verified model lands atomically at the final path', async () => {
    const dir = tempDir();
    const dest = join(dir, 'en_US-glados-high.onnx');
    const bytes = onnxBytes(8192);
    const result = await downloadVoiceModel({ url: 'https://models.test/x.onnx', destPath: dest, fetchImpl: mockFetch(mockResponse(bytes)) });
    expect(result.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
    // No leftover temp/partial files.
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a Content-Length-short (truncated) download is rejected; no partial at the final path', async () => {
    const dir = tempDir();
    const dest = join(dir, 'voice.onnx');
    const bytes = onnxBytes(100); // server promised more
    const result = await downloadVoiceModel({ url: 'u', destPath: dest, fetchImpl: mockFetch(mockResponse(bytes, { contentLength: 8192 })) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/truncated/i);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a too-small download (no Content-Length) is rejected', async () => {
    const dir = tempDir();
    const dest = join(dir, 'voice.onnx');
    const result = await downloadVoiceModel({ url: 'u', destPath: dest, fetchImpl: mockFetch(mockResponse(onnxBytes(100), { contentLength: null })) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too small/i);
    expect(existsSync(dest)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an HTML error page served with 200 is rejected', async () => {
    const dir = tempDir();
    const dest = join(dir, 'voice.onnx');
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>rate limited</body></html>'.padEnd(5000, ' '));
    const result = await downloadVoiceModel({ url: 'u', destPath: dest, fetchImpl: mockFetch(mockResponse(html)) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTML/i);
    expect(existsSync(dest)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('bad ONNX magic is rejected', async () => {
    const dir = tempDir();
    const dest = join(dir, 'voice.onnx');
    const bytes = new Uint8Array(8192); // first byte 0x00, not 0x08
    const result = await downloadVoiceModel({ url: 'u', destPath: dest, fetchImpl: mockFetch(mockResponse(bytes)) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a valid ONNX/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a .json config (magic check off) downloads when non-trivial', async () => {
    const dir = tempDir();
    const dest = join(dir, 'voice.onnx.json');
    const json = new TextEncoder().encode(JSON.stringify({ audio: { sample_rate: 22050 } }).padEnd(5000, ' '));
    const result = await downloadVoiceModel({ url: 'u', destPath: dest, fetchImpl: mockFetch(mockResponse(json)) });
    expect(result.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

function ttsConfig(): (key: string) => string {
  const values: Record<string, string> = {
    'voice.local.ttsEngine': 'piper',
    'voice.local.ttsBinary': '/opt/piper/piper',
    'voice.local.ttsModelPath': '/models/en_US-glados-high.onnx',
  };
  return (key) => values[key] ?? '';
}
const req: VoiceSynthesisRequest = { text: 'hello', metadata: {} } as VoiceSynthesisRequest;

function abortError(message: string, signal: string | undefined = 'SIGABRT'): Error {
  const e = new Error(message) as Error & { signal?: string };
  if (signal) e.signal = signal;
  return e;
}

describe('local TTS hard-failure circuit breaker (item 6)', () => {
  test('a piper onnxruntime abort trips the breaker: one honest state, no re-invocation', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: ttsConfig(),
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        throw abortError('terminate called after throwing an instance of \'Ort::Exception\'\n  what():  ... Unsupported model IR version: 9, max supported IR version: 8');
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // Second call must NOT invoke the crashing binary again.
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // The honest message names the cause (onnxruntime IR version) and what to check.
    await provider.synthesize!(req).catch((e: unknown) => {
      expect(String(e)).toMatch(/onnxruntime|IR version/i);
    });
    // Status surfaces exactly the one engine-unavailable line.
    const status = await provider.status!();
    expect(status.state).toBe('degraded');
    expect(status.detail).toMatch(/unavailable on this host/i);
  });

  test('a transient timeout does NOT trip the breaker', async () => {
    let calls = 0;
    const provider = createLocalVoiceProvider({
      readConfig: ttsConfig(),
      fileExists: () => true,
      runner: async () => {
        calls += 1;
        const e = new Error('spawn timed out') as Error & { killed?: boolean; signal?: string };
        e.killed = true;
        e.signal = 'SIGTERM';
        throw e;
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/timed out/i);
    await expect(provider.synthesize!(req)).rejects.toThrow(/timed out/i);
    expect(calls).toBe(2); // breaker NOT tripped by a transient failure
  });

  test('reconfiguring the engine clears the breaker', async () => {
    let calls = 0;
    let modelPath = '/models/bad.onnx';
    const values = (): Record<string, string> => ({
      'voice.local.ttsEngine': 'piper',
      'voice.local.ttsBinary': '/opt/piper/piper',
      'voice.local.ttsModelPath': modelPath,
    });
    const provider = createLocalVoiceProvider({
      readConfig: (key) => values()[key] ?? '',
      fileExists: () => true,
      runner: async (input) => {
        calls += 1;
        if (modelPath.includes('bad')) throw abortError('Ort::Exception Unsupported model IR version: 9');
        const outIdx = input.args.indexOf('--output_file');
        if (outIdx >= 0) writeFileSync(String(input.args[outIdx + 1]), 'RIFF-fake-wav');
        return { stdout: '' };
      },
    });
    await expect(provider.synthesize!(req)).rejects.toThrow(/unavailable on this host/i);
    expect(calls).toBe(1);
    // Point at a new (good) model — the breaker for the old config is cleared.
    modelPath = '/models/good.onnx';
    await provider.synthesize!(req);
    expect(calls).toBe(2);
  });
});
