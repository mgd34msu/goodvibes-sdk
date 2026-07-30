/**
 * method-catalog-voice-setup.ts — managed local-voice provisioning verbs.
 *
 * `voice.local.status` reads the managed runtime state (not-provisioned /
 * partial / provisioned / unsupported-platform, with a size-labeled offer).
 * `voice.local.install` is the one-act setup: it provisions the piper engine +
 * a default voice and pre-configures the voice.local.* keys (never overwriting a
 * user-set value), so local voice works immediately after.
 *
 * The three `voice.wake.*` verbs are here rather than in their own group because
 * they are the same capability — provisioning a pinned, checksum-verified voice
 * artifact and reporting honestly on it — and they attach through the voice-setup
 * service that is already composed. `voice.wake.model` exists because a browser
 * tab cannot fetch the pinned artifacts itself: the release assets answer with no
 * CORS header, so a tab reads the model from the daemon, same-origin, in bounded
 * chunks it verifies against the pinned checksum.
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

/**
 * Live progress of the ACTIVE voice.local.install run, served inside the
 * status read while — and only while — an install is running. The install verb
 * is plain request/response, so surfaces poll status during the provision to
 * render real per-component progress instead of busy→receipt.
 */
const INSTALL_IN_PROGRESS_SCHEMA = objectSchema({
  startedAt: NUMBER_SCHEMA,
  components: {
    type: 'array',
    items: objectSchema({
      component: STRING_SCHEMA,
      phase: { type: 'string', enum: ['skip', 'download', 'verify', 'extract', 'done', 'error'] },
      message: STRING_SCHEMA,
      bytesTotal: NUMBER_SCHEMA,
      bytesDone: NUMBER_SCHEMA,
    }, ['component', 'phase']),
  },
}, ['startedAt', 'components']);

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
  installInProgress: INSTALL_IN_PROGRESS_SCHEMA,
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

/** Content-verified state of one wake artifact on disk. */
const WAKE_ARTIFACT_SCHEMA = objectSchema({
  path: STRING_SCHEMA,
  verified: BOOLEAN_SCHEMA,
  corrupt: BOOLEAN_SCHEMA,
  bytes: NUMBER_SCHEMA,
}, ['path', 'verified', 'corrupt', 'bytes']);

const WAKE_STATUS_SCHEMA = objectSchema({
  ready: BOOLEAN_SCHEMA,
  reason: NULLABLE_STRING,
  classifier: WAKE_ARTIFACT_SCHEMA,
  mobileClassifier: WAKE_ARTIFACT_SCHEMA,
  notice: WAKE_ARTIFACT_SCHEMA,
  embedding: WAKE_ARTIFACT_SCHEMA,
  embeddingNotice: WAKE_ARTIFACT_SCHEMA,
  vad: WAKE_ARTIFACT_SCHEMA,
  vadNotice: WAKE_ARTIFACT_SCHEMA,
  vadReady: BOOLEAN_SCHEMA,
  downloadBytes: NUMBER_SCHEMA,
  modelVersion: NULLABLE_STRING,
  recallIsSyntheticOnly: BOOLEAN_SCHEMA,
}, [
  'ready', 'reason', 'classifier', 'mobileClassifier', 'notice', 'embedding', 'embeddingNotice',
  'vad', 'vadNotice', 'vadReady', 'downloadBytes', 'modelVersion', 'recallIsSyntheticOnly',
]);

const WAKE_PROVISION_RESULT_SCHEMA = objectSchema({
  ready: BOOLEAN_SCHEMA,
  mobileFormatReady: BOOLEAN_SCHEMA,
  vadReady: BOOLEAN_SCHEMA,
  modelVersion: NULLABLE_STRING,
  noticePath: NULLABLE_STRING,
  embeddingNoticePath: NULLABLE_STRING,
  recallIsSyntheticOnly: BOOLEAN_SCHEMA,
  outcomes: {
    type: 'array',
    items: objectSchema({
      component: {
        type: 'string',
        enum: ['classifier', 'mobile-classifier', 'notice', 'embedding', 'embedding-notice', 'vad', 'vad-notice'],
      },
      state: { type: 'string', enum: ['installed', 'skipped', 'failed'] },
      path: STRING_SCHEMA,
      bytes: NUMBER_SCHEMA,
      error: STRING_SCHEMA,
    }, ['component', 'state', 'path']),
  },
}, [
  'ready', 'mobileFormatReady', 'vadReady', 'modelVersion', 'noticePath', 'embeddingNoticePath',
  'recallIsSyntheticOnly', 'outcomes',
]);

const WAKE_MODEL_CHUNK_SCHEMA = objectSchema({
  component: {
    type: 'string',
    enum: ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice'],
  },
  offset: NUMBER_SCHEMA,
  bytes: NUMBER_SCHEMA,
  totalBytes: NUMBER_SCHEMA,
  sha256: STRING_SCHEMA,
  dataBase64: STRING_SCHEMA,
  complete: BOOLEAN_SCHEMA,
}, ['component', 'offset', 'bytes', 'totalBytes', 'sha256', 'dataBase64', 'complete']);

export const builtinGatewayVoiceSetupMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'voice.local.status',
    title: 'Get Managed Local-Voice Runtime State',
    description:
      'Whether the managed local voice runtime (piper TTS + a default voice) is installed: not-provisioned (with a size-labeled offer), partial, provisioned, or unsupported-platform. STT (whisper.cpp) reports its own managed state: goodvibes builds and pins the whisper.cpp bundle per platform (no official prebuilt exists; provisioning never compiles on your machine), so where a pinned bundle exists STT provisions like TTS, and elsewhere it reports unsupported honestly. While a voice.local.install run is active, the response also carries installInProgress — the live per-component progress (phase, byte sizes where known) of that run — so surfaces poll this read during the install to render real progress; the section is absent when no install is running. Read-only.',
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
  methodDescriptor({
    id: 'voice.wake.status',
    title: 'Get Wake-Word Model State',
    description:
      'Whether the pinned wake-word artifacts are on disk and VERIFIED BY CONTENT: the "hey goodvibes" classifier, the '
      + 'tflite form of the same classifier, the speech-embedding front end the classifier sits behind, the speech gate '
      + 'voice.wake.vadThreshold runs, and the attribution NOTICE belonging to each of the three redistributable artifacts '
      + '(the classifier\'s, the front end\'s and the gate\'s). Each reports '
      + 'verified, corrupt (present but failing its checksum — a truncated or swapped file, distinct from missing) and its '
      + 'byte size, with the total a fresh provision would download. Installing goodvibes provisions these, and a daemon '
      + 'retries at boot whatever the install could not fetch, so on a normal machine this reads ready without anyone having '
      + 'run a setup command; an offline install reports not-provisioned here until it is retried. The overall ready flag '
      + 'covers the classifier, the front end and both of THEIR NOTICEs — an artifact whose attribution is missing is not one '
      + 'this daemon may serve — and excludes two things: the tflite twin, which nothing here loads, so a host missing just '
      + 'that can still detect; and the speech gate, reported as vadReady instead, because voice.wake.vadThreshold defaults '
      + 'to 0 and the detector runs without it. Also restates that the model\'s published recall figures are measured on '
      + 'synthesised speech only, which any surface describing the model must carry. Never downloads. Read-only.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/wake/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: WAKE_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.wake.provision',
    title: 'Download the Wake-Word Models',
    description:
      'Download and checksum-verify the pinned wake-word classifier in both runtime formats (onnx and tflite), the '
      + 'speech-embedding front end, the speech gate voice.wake.vadThreshold runs, and the attribution NOTICE of each, into '
      + 'the goodvibes-managed directory — about 6.1 MB. '
      + 'Installing goodvibes already does '
      + 'this, and a daemon retries at boot, so this verb is the RECOVERY path: an install that was offline, an artifact that '
      + 'failed verification, or a re-provision after the pinned model changes. Resumable by re-running: an artifact that '
      + 'already matches its pin is skipped, and one that is present but fails verification is replaced rather than used. '
      + 'A failed or mismatched download keeps nothing at the destination. Single-flight: two surfaces asking at once — or a '
      + 'boot attempt and a user asking — join one download instead of racing for the same files.',
    category: 'health',
    scopes: ['write:config'],
    http: { method: 'POST', path: '/api/voice/wake/provision' },
    inputSchema: objectSchema({}, []),
    outputSchema: WAKE_PROVISION_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.wake.model.get',
    title: 'Read Wake-Word Model Bytes',
    description:
      'Read one provisioned wake artifact in bounded chunks, for a surface that cannot fetch it itself — a browser tab, whose '
      + 'cross-origin fetch of the release asset is refused because that asset answers with no CORS header. Each chunk carries '
      + 'the offset, the whole artifact\'s size, and its PINNED sha256, so a client reassembles the file and verifies it against '
      + 'the pin: a truncated transfer fails at the consumer instead of loading as a model that silently never detects. '
      + 'Both classifier formats are served — "classifier" is the onnx build a browser tab loads, "tflite" the same classifier '
      + 'for a runtime that cannot — as is the speech gate voice.wake.vadThreshold runs ("vad"), and so is the attribution '
      + 'NOTICE of each redistributable artifact ("notice" for the classifier, "embedding-notice" for the front end, '
      + '"vad-notice" for the gate), because a client that can fetch the bytes but not the NOTICE '
      + 'cannot satisfy the terms it received them under. Serves what is on disk and does not download; installation puts it '
      + 'there, and voice.wake.provision is the recovery path when it is missing.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/voice/wake/model' },
    inputSchema: objectSchema({
      component: {
        type: 'string',
        enum: ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice'],
      },
      offset: NUMBER_SCHEMA,
      maxBytes: NUMBER_SCHEMA,
    }, ['component']),
    outputSchema: WAKE_MODEL_CHUNK_SCHEMA,
  }),
];
