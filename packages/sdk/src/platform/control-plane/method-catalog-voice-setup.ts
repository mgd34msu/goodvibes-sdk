/**
 * method-catalog-voice-setup.ts — managed local-voice provisioning verbs.
 *
 * `voice.local.status` reads the managed runtime state (not-provisioned /
 * partial / provisioned / unsupported-platform, with a size-labeled offer).
 * `voice.local.install` is the one-act setup: it provisions the piper engine +
 * a default voice and pre-configures the voice.local.* keys (never overwriting a
 * user-set value), so local voice works immediately after.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';

const NULLABLE_NUMBER = { anyOf: [NUMBER_SCHEMA, { type: 'null' }] };
const NULLABLE_STRING = { anyOf: [STRING_SCHEMA, { type: 'null' }] };

const RUNTIME_STATUS_SCHEMA = objectSchema({
  platform: NULLABLE_STRING,
  state: { type: 'string', enum: ['not-provisioned', 'partial', 'provisioned', 'unsupported-platform'] },
  tts: objectSchema({
    engine: STRING_SCHEMA,
    binaryPresent: BOOLEAN_SCHEMA,
    voicePresent: BOOLEAN_SCHEMA,
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
  }, ['engine', 'binaryPresent', 'voicePresent', 'binaryPath', 'modelPath']),
  stt: objectSchema({
    engine: STRING_SCHEMA,
    supported: BOOLEAN_SCHEMA,
    state: { type: 'string', enum: ['not-provisioned', 'partial', 'provisioned', 'unsupported-platform'] },
    binaryPresent: BOOLEAN_SCHEMA,
    modelPresent: BOOLEAN_SCHEMA,
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'supported', 'state', 'binaryPresent', 'modelPresent', 'binaryPath', 'modelPath']),
  offerBytes: NULLABLE_NUMBER,
}, ['platform', 'state', 'tts', 'stt', 'offerBytes']);

const INSTALL_RESULT_SCHEMA = objectSchema({
  provisioned: BOOLEAN_SCHEMA,
  platform: NULLABLE_STRING,
  tts: objectSchema({
    engine: STRING_SCHEMA,
    state: { type: 'string', enum: ['provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch'] },
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'state']),
  stt: objectSchema({
    engine: STRING_SCHEMA,
    state: { type: 'string', enum: ['provisioned', 'unsupported-platform', 'download-failed', 'checksum-mismatch', 'bundle-unavailable', 'sideload-mismatch'] },
    binaryPath: STRING_SCHEMA,
    modelPath: STRING_SCHEMA,
    reason: STRING_SCHEMA,
  }, ['engine', 'state']),
  components: {
    type: 'array',
    items: objectSchema({
      id: STRING_SCHEMA,
      state: { type: 'string', enum: ['installed', 'skipped', 'failed'] },
      bytes: NUMBER_SCHEMA,
      error: STRING_SCHEMA,
    }, ['id', 'state']),
  },
  configured: objectSchema({
    set: { type: 'array', items: objectSchema({ key: STRING_SCHEMA, value: STRING_SCHEMA }, ['key', 'value']) },
    skipped: { type: 'array', items: objectSchema({ key: STRING_SCHEMA, reason: STRING_SCHEMA }, ['key', 'reason']) },
  }, ['set', 'skipped']),
}, ['provisioned', 'platform', 'tts', 'stt', 'components', 'configured']);

export const builtinGatewayVoiceSetupMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'voice.local.status',
    title: 'Get Managed Local-Voice Runtime State',
    description:
      'Whether the managed local voice runtime (piper TTS + a default voice) is installed: not-provisioned (with a size-labeled offer), partial, provisioned, or unsupported-platform. STT (whisper.cpp) reports its own managed state: goodvibes builds and pins the whisper.cpp bundle per platform (no official prebuilt exists; provisioning never compiles on your machine), so where a pinned bundle exists STT provisions like TTS, and elsewhere it reports unsupported honestly. Read-only.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/local/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: RUNTIME_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.local.install',
    title: 'Install the Managed Local-Voice Runtime',
    description:
      'One-act setup: download + checksum-verify the piper TTS engine, a default voice, and (where a pinned goodvibes-built bundle exists) the whisper.cpp STT engine with its default model into the goodvibes-managed directory, then point the voice.local.* config keys at the managed install — never overwriting a key you already set to a custom value (skipped keys are reported). After this, local TTS works with zero further configuration. Downloads only when you ask; a failed or checksum-mismatched download keeps nothing.',
    category: 'health',
    scopes: ['write:config'],
    http: { method: 'POST', path: '/api/voice/local/install' },
    inputSchema: objectSchema({}, []),
    outputSchema: INSTALL_RESULT_SCHEMA,
  }),
];
