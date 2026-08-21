import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOptionalDependency } from '../../utils/optional-dependency.js';
import type { VoiceDescriptor, VoiceProvider } from '../types.js';
import {
  buildStatus,
  inferExtFromOutputFormat,
  inferMimeFromExtension,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';

type MicrosoftVoiceListEntry = {
  ShortName?: string | undefined;
  FriendlyName?: string | undefined;
  Locale?: string | undefined;
  Gender?: string | undefined;
  VoiceTag?: {
    ContentCategories?: string[] | undefined;
    VoicePersonalities?: string[] | undefined;
  };
};

type EdgeTtsDrm = typeof import('node-edge-tts/dist/drm.js');

/**
 * The DRM constants and token generator live in a deep subpath of the same
 * optional package, so they get the same treatment as the package itself: no
 * static specifier on the module graph, resolved at the call that needs it.
 */
async function loadEdgeTtsDrm(): Promise<EdgeTtsDrm> {
  const loaded = await loadOptionalDependency(
    'node-edge-tts/dist/drm.js',
    () => import('node-edge-tts/dist/drm.js'),
  );
  if (!loaded.available) throw new Error(loaded.reason);
  return loaded.module;
}

async function buildMicrosoftVoiceHeaders(): Promise<Record<string, string>> {
  const { CHROMIUM_FULL_VERSION, generateSecMsGecToken } = await loadEdgeTtsDrm();
  const major = CHROMIUM_FULL_VERSION.split('.')[0] || '0';
  return {
    Authority: 'speech.platform.bing.com',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Accept: '*/*',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    'Sec-MS-GEC': generateSecMsGecToken(),
    'Sec-MS-GEC-Version': `1-${CHROMIUM_FULL_VERSION}`,
  };
}

async function listMicrosoftVoices(): Promise<readonly VoiceDescriptor[]> {
  const response = await instrumentedFetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${(await loadEdgeTtsDrm()).TRUSTED_CLIENT_TOKEN}`,
    { headers: await buildMicrosoftVoiceHeaders() },
  );
  if (!response.ok) throw new Error(`Microsoft voices failed: HTTP ${response.status}`);
  const payload = await response.json() as MicrosoftVoiceListEntry[];
  return Array.isArray(payload)
    ? payload
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? '',
          label: voice.FriendlyName?.trim() || voice.ShortName?.trim() || 'Voice',
          locale: voice.Locale?.trim(),
          gender: voice.Gender?.trim(),
          metadata: {
            categories: voice.VoiceTag?.ContentCategories ?? [],
            personalities: voice.VoiceTag?.VoicePersonalities ?? [],
          },
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function createMicrosoftProvider(): VoiceProvider {
  return {
    id: 'microsoft',
    label: 'Microsoft',
    capabilities: ['tts', 'voice-list'],
    status() {
      return buildStatus(
        'microsoft',
        'Microsoft',
        ['tts', 'voice-list'],
        true,
        'Microsoft Edge speech does not require an API key and remains optional operator convenience.',
      );
    },
    async listVoices() {
      return listMicrosoftVoices();
    },
    async synthesize(request) {
      const outputFormat = request.format === 'wav'
        ? 'riff-24khz-16bit-mono-pcm'
        : 'audio-24khz-48kbitrate-mono-mp3';
      const ext = inferExtFromOutputFormat(outputFormat);
      const dir = mkdtempSync(join(tmpdir(), 'gv-edge-tts-'));
      const outPath = join(dir, `speech${ext}`);
      try {
        // `node-edge-tts` is an optionalDependency: reached here, at the one
        // call that needs it, rather than at module init. A static import made
        // every graph containing this provider, the daemon's included,
        // unloadable when the package was absent; see
        // utils/optional-dependency.ts for the measured failure.
        const loaded = await loadOptionalDependency('node-edge-tts', () => import('node-edge-tts'));
        if (!loaded.available) throw new Error(loaded.reason);
        const { EdgeTTS } = loaded.module;
        const tts = new EdgeTTS({
          voice: request.voiceId?.trim() || 'en-US-MichelleNeural',
          lang: 'en-US',
          outputFormat,
          rate: typeof request.speed === 'number' && Number.isFinite(request.speed)
            ? `${Math.round((request.speed - 1) * 100)}%`
            : 'default',
        });
        await tts.ttsPromise(request.text, outPath);
        const buffer = readFileSync(outPath);
        return {
          providerId: 'microsoft',
          audio: {
            mimeType: inferMimeFromExtension(ext),
            format: ext === '.wav' ? 'wav' : 'mp3',
            dataBase64: buffer.toString('base64'),
            metadata: {
              voiceId: request.voiceId?.trim() || 'en-US-MichelleNeural',
            },
          },
          metadata: {},
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
