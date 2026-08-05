/**
 * The failures behind this file all came from one session in which nothing was
 * broken in a way anything reported:
 *
 *  - a runtime record left by a daemon that had exited made every daemon-owned
 *    settings READ answer `unavailable` against a dead port, for days, while a
 *    live daemon sat on another port;
 *  - the same setting could be WRITTEN successfully and then read back as
 *    missing, because the two directions resolved the daemon independently;
 *  - `/voice setup` installed a managed runtime, left the config pointing at a
 *    hand-built install it had just replaced, and reported "provisioned";
 *  - enabling `voice.wake.enabled` on a surface whose row was off did nothing
 *    at all, silently.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyConfigWrite,
  discoverDaemonEndpoint,
  loadDaemonConfigSnapshot,
  readEffectiveConfig,
  type DaemonConfigRouterDeps,
} from '../packages/sdk/src/platform/config/index.js';
import {
  detachedDaemonReapedPath,
  readDetachedDaemonReapReceipt,
  recordDetachedDaemonRuntime,
} from '../packages/sdk/src/platform/runtime/detached-daemon-runtime.js';
import { preconfigureLocalVoiceKeys } from '../packages/sdk/src/platform/voice/provisioning/config-preconfigure.js';
import { proveVoiceRoundTrip } from '../packages/sdk/src/platform/voice/provisioning/round-trip-proof.js';
import { resolveWakeEnablementCompanion } from '../packages/sdk/src/platform/voice/wake/settings.js';
import { transcribeThroughBestRoute, SttRoutesExhaustedError } from '../packages/sdk/src/platform/voice/stt-routing.js';
import {
  readVoiceDiagnostics,
  recordVoiceDiagnostic,
} from '../packages/sdk/src/platform/voice/diagnostics.js';
import {
  planVoiceSetupChain,
  voiceSetupChainStrings,
  voiceSetupStepsOfKind,
} from '../packages/sdk/src/platform/voice/setup-chain.js';
import {
  SETUP_INTENT_CONTRACT_PROMPT,
  mentionsUserTypedCommand,
} from '../packages/sdk/src/platform/runtime/setup-contract.js';

function daemonHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-daemon-home-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A local config manager stub, enough for the write path. */
function localStore(): {
  get(key: string): unknown;
  setDynamic(key: string, value: unknown): void;
  getConfigPath(): string;
  getDaemonTierPath(): string;
} {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    setDynamic: (key, value) => { values.set(key, value); },
    getConfigPath: () => '/tmp/settings.json',
    getDaemonTierPath: () => '/tmp/daemon-settings.json',
  };
}

describe('a runtime record is a hint, validated before it is trusted', () => {
  test('a record naming a dead pid is reaped, receipted, and discovery falls through to the live daemon', async () => {
    const home = daemonHome();
    recordDetachedDaemonRuntime(home, {
      pid: 424242,
      host: '127.0.0.1',
      port: 4444,
      command: 'goodvibes-daemon',
      startedAt: new Date().toISOString(),
    });

    const answered: string[] = [];
    const deps: DaemonConfigRouterDeps = {
      hostsDaemon: false,
      daemonHomeDir: home,
      // The pid in the record no longer exists.
      isProcessAlive: () => false,
      // The live daemon is on a DIFFERENT port, discoverable from its own config.
      readDaemonBinding: () => ({ hostMode: 'local', host: '127.0.0.1', port: 3421, tlsMode: 'off' }),
      fetchImpl: (async (url: string | URL) => {
        answered.push(String(url));
        return new Response(JSON.stringify({ voice: { wake: { enabled: true } } }), { status: 200 });
      }) as unknown as typeof fetch,
    };

    const snapshot = await loadDaemonConfigSnapshot(deps);

    // The read RESOLVED, against the live daemon, not the dead port.
    expect(snapshot.error).toBeNull();
    expect(snapshot.config).toEqual({ voice: { wake: { enabled: true } } });
    expect(snapshot.endpoint?.baseUrl).toBe('http://127.0.0.1:3421');
    expect(answered.every((url) => !url.includes('4444'))).toBe(true);

    // The stale record is gone, and its removal left evidence.
    expect(existsSync(join(home, 'detached-daemon.json'))).toBe(false);
    expect(existsSync(detachedDaemonReapedPath(home))).toBe(true);
    const receipt = readDetachedDaemonReapReceipt(home);
    expect(receipt?.record.port).toBe(4444);
    expect(receipt?.reason).toContain('no longer exists');
  });

  test('a record whose pid is alive but whose port answers nothing is reaped, then the derived binding is used', async () => {
    const home = daemonHome();
    recordDetachedDaemonRuntime(home, {
      pid: 1,
      host: '127.0.0.1',
      port: 4444,
      command: 'goodvibes-daemon',
      startedAt: new Date().toISOString(),
    });

    const deps: DaemonConfigRouterDeps = {
      hostsDaemon: false,
      daemonHomeDir: home,
      isProcessAlive: () => true,
      readDaemonBinding: () => ({ hostMode: 'local', host: '127.0.0.1', port: 3421, tlsMode: 'off' }),
      fetchImpl: (async (url: string | URL) => {
        if (String(url).includes('4444')) throw new Error('connect ECONNREFUSED 127.0.0.1:4444');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    };

    const snapshot = await loadDaemonConfigSnapshot(deps);
    expect(snapshot.error).toBeNull();
    expect(snapshot.endpoint?.baseUrl).toBe('http://127.0.0.1:3421');
    expect(readDetachedDaemonReapReceipt(home)?.reason).toContain('nothing answered');
  });

  test('a record for a daemon found nowhere still fails loudly rather than reading a local value', async () => {
    const home = daemonHome();
    recordDetachedDaemonRuntime(home, {
      pid: 1,
      host: '127.0.0.1',
      port: 4444,
      command: 'goodvibes-daemon',
      startedAt: new Date().toISOString(),
    });

    const entries = await readEffectiveConfig(['surfaces.telegram.botUsername'], localStore(), {
      hostsDaemon: false,
      daemonHomeDir: home,
      isProcessAlive: () => true,
      readDaemonBinding: () => null,
      fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch,
    });

    // Unavailable, NOT a local default dressed up as the daemon's setting.
    expect(entries[0]?.status).toBe('unavailable');
    expect(entries[0]?.value).toBeUndefined();
  });

  test('an explicitly configured endpoint is never downgraded by a liveness check', () => {
    const endpoint = discoverDaemonEndpoint({
      hostsDaemon: false,
      endpoint: { baseUrl: 'http://10.0.0.5:3421', source: 'configured' },
    });
    expect(endpoint?.certain).toBe(true);
    expect(endpoint?.baseUrl).toBe('http://10.0.0.5:3421');
  });
});

describe('reads and writes resolve the daemon the same way', () => {
  test('a write through the connected host is read back through the same connection', async () => {
    // ONE connection answers both directions. This is the asymmetry that made a
    // successful write immediately unreadable: writes went through the
    // connected host and reads went off rediscovering an address.
    const hostConfig: Record<string, unknown> = { surfaces: { telegram: { botUsername: 'old_bot' } } };
    const deps: DaemonConfigRouterDeps = {
      hostsDaemon: false,
      // No daemon home and no binding at all: discovery could not find anything.
      readDaemonSnapshot: async () => hostConfig,
      endpoint: { baseUrl: 'http://connected-host', source: 'the connection this process already holds' },
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { key: string; value: unknown };
        (hostConfig['surfaces'] as { telegram: Record<string, unknown> }).telegram['botUsername'] = body.value;
        return new Response(JSON.stringify({ value: body.value, persistedTo: 'the host' }), { status: 200 });
      }) as unknown as typeof fetch,
    };

    const store = localStore();
    const written = await applyConfigWrite('surfaces.telegram.botUsername', 'goodvibes_agent_bot', store, deps);
    expect(written.appliedBy).toBe('daemon');

    const [entry] = await readEffectiveConfig(['surfaces.telegram.botUsername'], store, deps);
    expect(entry?.status).toBe('ok');
    expect(entry?.value).toBe('goodvibes_agent_bot');
  });

  test('a connected host that cannot answer is unavailable, not silently local', async () => {
    const [entry] = await readEffectiveConfig(['surfaces.telegram.botUsername'], localStore(), {
      hostsDaemon: false,
      readDaemonSnapshot: async () => null,
    });
    expect(entry?.status).toBe('unavailable');
  });
});

describe('speech-to-text goes to the connected host first', () => {
  const audio = { mimeType: 'audio/wav', format: 'wav', dataBase64: 'AAAA' };

  test('the connected host transcribes even when the in-process provider is broken', async () => {
    const result = await transcribeThroughBestRoute(audio, {
      connectedHost: {
        route: 'connected-host',
        provider: 'whisper-cpp',
        configSource: 'the daemon',
        transcribe: async () => 'turn the lights off',
      },
      inProcess: {
        route: 'in-process',
        provider: 'local',
        configSource: 'this process',
        transcribe: async () => { throw new Error('local STT is not configured'); },
      },
    });
    expect(result.text).toBe('turn the lights off');
    expect(result.route).toBe('connected-host');
  });

  test('falling back to this process states what it fell back from', async () => {
    const result = await transcribeThroughBestRoute(audio, {
      connectedHost: {
        route: 'connected-host',
        provider: 'whisper-cpp',
        configSource: 'the daemon',
        transcribe: async () => { throw new Error('the host is not reachable'); },
      },
      inProcess: {
        route: 'in-process',
        provider: 'local',
        configSource: 'this process',
        transcribe: async () => 'hello',
      },
    });
    expect(result.text).toBe('hello');
    expect(result.route).toBe('in-process');
    expect(result.explanation).toContain('the host is not reachable');
  });

  test('every attempt is recorded with provider, config source and the verbatim error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-voice-diag-'));
    await expect(transcribeThroughBestRoute(audio, {
      connectedHost: {
        route: 'connected-host',
        provider: 'whisper-cpp',
        configSource: 'the daemon settings',
        transcribe: async () => { throw new Error('HTTP 409 provider not configured'); },
      },
      recordDiagnostic: (entry) => { recordVoiceDiagnostic(root, entry); },
    })).rejects.toThrow(SttRoutesExhaustedError);

    const [entry] = readVoiceDiagnostics(root);
    expect(entry?.ok).toBe(false);
    expect(entry?.provider).toBe('whisper-cpp');
    expect(entry?.configSource).toBe('the daemon settings');
    expect(entry?.error).toBe('HTTP 409 provider not configured');
  });

  test('the diagnostics store is bounded by count', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-voice-diag-bound-'));
    for (let index = 0; index < 12; index += 1) {
      recordVoiceDiagnostic(root, {
        at: new Date().toISOString(),
        operation: 'stt',
        route: 'in-process',
        ok: false,
        provider: 'local',
        configSource: 'this process',
        error: `failure ${index}`,
      }, { maxEntries: 5 });
    }
    const entries = readVoiceDiagnostics(root);
    expect(entries).toHaveLength(5);
    expect(entries.at(-1)?.error).toBe('failure 11');
  });

  test('a torn diagnostics file is not served as data', () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-voice-diag-torn-'));
    writeFileSync(join(root, 'voice-diagnostics.json'), '{"entries":[{"at":"x"');
    expect(readVoiceDiagnostics(root)).toEqual([]);
  });
});

describe('a managed install supersedes a manual one and says which', () => {
  test('config pointing at a hand-built install is repointed, naming the path it replaced', () => {
    const values: Record<string, string> = {
      'voice.local.ttsEngine': 'piper',
      'voice.local.ttsBinary': '/home/mike/.local/opt/piper/piper',
      'voice.local.ttsModelPath': '/home/mike/.local/opt/piper/en_US-lessac-low.onnx',
    };
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (key) => values[key] ?? '',
      setConfig: (key, value) => { values[key] = value; },
      managedRoot: '/home/mike/.goodvibes/voice',
      ttsEngine: 'piper',
      ttsBinary: '/home/mike/.goodvibes/voice/piper/piper',
      ttsModelPath: '/home/mike/.goodvibes/voice/piper/en_US-lessac-low.onnx',
    });

    expect(values['voice.local.ttsBinary']).toBe('/home/mike/.goodvibes/voice/piper/piper');
    const binary = receipt.superseded.find((entry) => entry.key === 'voice.local.ttsBinary');
    expect(binary?.previousValue).toBe('/home/mike/.local/opt/piper/piper');
  });

  test('a path already inside the managed root is left alone', () => {
    const values: Record<string, string> = {
      'voice.local.ttsEngine': 'piper',
      'voice.local.ttsBinary': '/managed/voice/piper/piper',
      'voice.local.ttsModelPath': '/managed/voice/piper/voice.onnx',
    };
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (key) => values[key] ?? '',
      setConfig: (key, value) => { values[key] = value; },
      managedRoot: '/managed/voice',
      ttsEngine: 'piper',
      ttsBinary: '/managed/voice/piper/piper',
      ttsModelPath: '/managed/voice/piper/voice.onnx',
    });
    expect(receipt.superseded).toHaveLength(0);
  });

  test('a value the user deliberately cleared is still never written back', () => {
    const values: Record<string, string> = { 'voice.local.ttsBinary': '' };
    const receipt = preconfigureLocalVoiceKeys({
      getConfig: (key) => values[key] ?? '',
      setConfig: (key, value) => { values[key] = value; },
      managedRoot: '/managed/voice',
      ttsEngine: 'piper',
      ttsBinary: '/managed/voice/piper/piper',
      ttsModelPath: '/managed/voice/piper/voice.onnx',
      priorInstallWrites: { 'voice.local.ttsBinary': '/managed/voice/piper/piper' },
    });
    expect(values['voice.local.ttsBinary']).toBe('');
    expect(receipt.skipped.some((entry) => entry.key === 'voice.local.ttsBinary')).toBe(true);
  });
});

describe('provisioning ends by proving the round trip', () => {
  test('a phrase spoken and heard back is reported with the text that came back', async () => {
    const proof = await proveVoiceRoundTrip({
      ttsEngine: 'piper',
      ttsBinary: '/managed/piper',
      ttsModelPath: '/managed/voice.onnx',
      sttEngine: 'whisper-cpp',
      sttBinary: '/managed/whisper-cli',
      sttModelPath: '/managed/ggml-tiny.en.bin',
      scratchDir: mkdtempSync(join(tmpdir(), 'gv-proof-')),
      runner: async (input) => {
        if (input.binary === '/managed/piper') {
          writeFileSync(String(input.args[input.args.indexOf('--output_file') + 1]), 'RIFFwav-bytes');
          return { stdout: '' };
        }
        return { stdout: ' The quick brown fox jumps over the lazy dog. ' };
      },
    });
    expect(proof.proved).toBe(true);
    expect(proof.transcript).toBe('The quick brown fox jumps over the lazy dog.');
    expect(proof.summary).toContain('heard it back');
  });

  test('a recogniser that returns something else is NOT reported as provisioned', async () => {
    const proof = await proveVoiceRoundTrip({
      ttsEngine: 'piper',
      ttsBinary: '/managed/piper',
      ttsModelPath: '/managed/voice.onnx',
      sttEngine: 'whisper-cpp',
      sttBinary: '/managed/whisper-cli',
      sttModelPath: '/managed/ggml-tiny.en.bin',
      scratchDir: mkdtempSync(join(tmpdir(), 'gv-proof-bad-')),
      runner: async (input) => {
        if (input.binary === '/managed/piper') {
          writeFileSync(String(input.args[input.args.indexOf('--output_file') + 1]), 'RIFFwav-bytes');
          return { stdout: '' };
        }
        return { stdout: '[BLANK_AUDIO]' };
      },
    });
    expect(proof.proved).toBe(false);
    expect(proof.stage).toBe('compare');
  });

  test('an engine that cannot speak fails the proof at the stage it failed', async () => {
    const proof = await proveVoiceRoundTrip({
      ttsEngine: 'piper',
      ttsBinary: '/managed/piper',
      ttsModelPath: '/managed/voice.onnx',
      sttEngine: 'whisper-cpp',
      sttBinary: '/managed/whisper-cli',
      sttModelPath: '/managed/ggml-tiny.en.bin',
      scratchDir: mkdtempSync(join(tmpdir(), 'gv-proof-fail-')),
      runner: async () => { throw new Error('piper: SIGABRT'); },
    });
    expect(proof.proved).toBe(false);
    expect(proof.stage).toBe('synthesize');
    expect(proof.error).toContain('SIGABRT');
  });
});

describe('the two flags that gate wake move together', () => {
  const read = (values: Record<string, unknown>) => (key: string): unknown => values[key];

  test('enabling the feature on an opted-out surface sets the surface row and says so', () => {
    const companion = resolveWakeEnablementCompanion(
      'voice.wake.enabled',
      true,
      read({ 'voice.wake.surfaces.agent': false }),
      'agent',
    );
    expect(companion?.key).toBe('voice.wake.surfaces.agent');
    expect(companion?.value).toBe(true);
    expect(companion?.message).toContain('nothing listening');
  });

  test('a surface already opted in needs no companion write', () => {
    expect(resolveWakeEnablementCompanion(
      'voice.wake.enabled',
      true,
      read({ 'voice.wake.surfaces.tui': true }),
      'tui',
    )).toBeNull();
  });

  test('turning the feature off is a complete instruction on its own', () => {
    expect(resolveWakeEnablementCompanion(
      'voice.wake.enabled',
      false,
      read({ 'voice.wake.surfaces.agent': false }),
      'agent',
    )).toBeNull();
  });
});

describe('a setup request is completed, proposed and asked — never handed over as a command', () => {
  const base = {
    surface: 'agent' as const,
    wakeEnabled: false,
    surfaceEnabled: false,
    wakeProvisioned: true,
    sttReady: false,
    ttsReady: true,
    inputDevice: '',
  };

  test('a wake setup request DOES the ask and PROPOSES the speech-to-text it implies', () => {
    const chain = planVoiceSetupChain('wake', base);
    const done = voiceSetupStepsOfKind(chain, 'do');
    const proposed = voiceSetupStepsOfKind(chain, 'propose');

    expect(done.some((step) => step.subject === 'wake')).toBe(true);
    // The inferred extension is offered, not silently performed and not dropped.
    expect(proposed.map((step) => step.subject)).toContain('stt');
    expect(proposed[0]?.message).toContain('?');
  });

  test('an empty input device is STATED, never asked about', () => {
    const chain = planVoiceSetupChain('wake', base);
    const device = voiceSetupStepsOfKind(chain, 'do').find((step) => step.subject === 'input-device');
    expect(device?.message).toContain('system default input');
    expect(voiceSetupStepsOfKind(chain, 'ask').some((step) => step.subject === 'input-device')).toBe(false);
  });

  test('local versus a hosted account is a genuine fork, with one line of trade each', () => {
    const chain = planVoiceSetupChain('tts', { ...base, ttsReady: false, cloudVoiceProviders: ['elevenlabs'] });
    const fork = voiceSetupStepsOfKind(chain, 'ask').find((step) => step.subject === 'tts-provider');
    expect(fork?.options).toHaveLength(2);
    for (const option of fork?.options ?? []) expect(option.trade.length).toBeGreaterThan(0);
  });

  test('with no credential on the host there is no fork to ask about', () => {
    const chain = planVoiceSetupChain('tts', { ...base, ttsReady: false });
    expect(voiceSetupStepsOfKind(chain, 'ask')).toHaveLength(0);
    expect(voiceSetupStepsOfKind(chain, 'do').some((step) => step.subject === 'tts')).toBe(true);
  });

  test('no setup reply tells the user to type a command', () => {
    const chains = [
      planVoiceSetupChain('wake', base),
      planVoiceSetupChain('voice', base),
      planVoiceSetupChain('tts', { ...base, ttsReady: false, cloudVoiceProviders: ['elevenlabs'] }),
      planVoiceSetupChain('stt', { ...base, sttReady: true }),
    ];
    for (const chain of chains) {
      for (const line of voiceSetupChainStrings(chain)) {
        expect({ line, instructs: mentionsUserTypedCommand(line) }).toEqual({ line, instructs: false });
      }
    }
  });

  test('the contract text names the repertoire generally, without naming a service', () => {
    // General on purpose: a service nobody has thought of yet gets the same
    // treatment as the ones that prompted this.
    expect(SETUP_INTENT_CONTRACT_PROMPT).toContain('walkthrough');
    expect(SETUP_INTENT_CONTRACT_PROMPT).toContain('browser');
    expect(SETUP_INTENT_CONTRACT_PROMPT).toContain('CLI');
    expect(SETUP_INTENT_CONTRACT_PROMPT).toContain('interview');
    expect(SETUP_INTENT_CONTRACT_PROMPT.toLowerCase()).not.toContain('elevenlabs');
    expect(SETUP_INTENT_CONTRACT_PROMPT.toLowerCase()).not.toContain('wake word');
  });

  test('the command detector catches the shapes that actually shipped', () => {
    expect(mentionsUserTypedCommand('Run /voice setup to provision the managed local runtime.')).toBe(true);
    expect(mentionsUserTypedCommand('set voice.wake.surfaces.agent to true')).toBe(true);
    expect(mentionsUserTypedCommand('/voice wake setup')).toBe(true);
    expect(mentionsUserTypedCommand('Wake-word detection is on and this surface is listening.')).toBe(false);
    expect(mentionsUserTypedCommand('Downloaded from https://example.com/model.onnx')).toBe(false);
  });
});
