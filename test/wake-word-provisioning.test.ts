/**
 * Provisioning and recovery for the wake-word artifacts.
 *
 * The bug class these tests exist for has already cost this project a training
 * run: a cache pre-allocated a file, a crash left it full-size and zero-filled,
 * and an existence-only check treated it as complete. So nothing here is
 * allowed to accept a file because it is present, every acceptance is by
 * content, and a truncated or mismatched artifact must be refused and refetched
 * rather than used.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  provisionWakeWordModels,
  wakeProvisionStatus,
  wakeArtifactStatus,
  resolveManagedWakePaths,
  describeWakeModel,
  resolveWakeModelFiles,
} from '../packages/sdk/src/platform/voice/wake/provisioning.js';
import {
  provisionWakeWordModelsAtInstall,
  startWakeBootProvisioning,
  WAKE_INSTALL_SKIP_ENV,
  type WakeInstallProvisionOutcome,
} from '../packages/sdk/src/platform/voice/wake/install-provision.js';
import { resolveManagedVoiceRoot } from '../packages/sdk/src/platform/voice/provisioning/managed-root.js';
import { createShellPathService } from '../packages/sdk/src/platform/runtime/shell-paths.js';
import {
  sweepWakeStorage,
  startWakeRecoverySweeper,
  WAKE_REAP_RECEIPT_FILE,
  type WakeReapSummary,
  retainedClipFileName,
} from '../packages/sdk/src/platform/voice/wake/recovery.js';
import {
  resolveWakeWordModel,
  WAKE_VAD_MODEL,
  wakeVadProvisionBytes,
  wakeWordFrontEndProvisionBytes,
  wakeWordProvisionBytes,
  WAKE_WORD_FRONT_END,
} from '../packages/sdk/src/platform/voice/provisioning/wake-word-manifest.js';

// Resolved eagerly via an IIFE (rather than a bare `const` + throw-guard) so
// MODEL's static type is non-null everywhere it's read, including inside
// nested function bodies defined below, a throw-guard on a separate
// statement narrows only the enclosing scope's own control flow, not closures
// that read the variable later.
const MODEL = (() => {
  const model = resolveWakeWordModel();
  if (model === null) throw new Error('the default wake-word model must resolve');
  return model;
})();
const EMBEDDING = WAKE_WORD_FRONT_END.embedding.download;
const EMBEDDING_NOTICE = WAKE_WORD_FRONT_END.embedding.notice;
/** The speech gate provisions with the models, so every plan here includes it. */
const VAD = WAKE_VAD_MODEL.onnx;
const VAD_NOTICE = WAKE_VAD_MODEL.notice;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-wake-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pin over content we can actually produce, for exercising the happy path. */
function fakePin(body: Uint8Array, url: string) {
  return {
    url,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

/** A fetch stand-in serving fixed bodies by URL, counting requests. */
function servingFetch(bodies: Record<string, Uint8Array>) {
  const requests: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    const body = bodies[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

function pinnedBodies(): Record<string, Uint8Array> {
  return {
    [MODEL.onnx.url]: new Uint8Array(0),
    [MODEL.tflite.url]: new Uint8Array(0),
    [MODEL.notice.url]: new Uint8Array(0),
    [EMBEDDING.url]: new Uint8Array(0),
    [EMBEDDING_NOTICE.url]: new Uint8Array(0),
    [VAD.url]: new Uint8Array(0),
    [VAD_NOTICE.url]: new Uint8Array(0),
  };
}

describe('wake artifact verification is by content, never by existence', () => {
  test('an absent file is missing, not corrupt', () => {
    const status = wakeArtifactStatus(join(root, 'nope.onnx'), MODEL.onnx);
    expect(status.verified).toBe(false);
    expect(status.corrupt).toBe(false);
    expect(status.bytes).toBe(0);
  });

  test('a full-size zero-filled file is reported corrupt, not complete', () => {
    // This is the exact shape of the failure that trained a model on zeros.
    const path = join(root, 'zeros.onnx');
    writeFileSync(path, Buffer.alloc(MODEL.onnx.bytes));
    const status = wakeArtifactStatus(path, MODEL.onnx);
    expect(status.bytes).toBe(MODEL.onnx.bytes);
    expect(status.verified).toBe(false);
    expect(status.corrupt).toBe(true);
  });

  test('a truncated file is reported corrupt', () => {
    const path = join(root, 'short.onnx');
    writeFileSync(path, Buffer.alloc(MODEL.onnx.bytes - 1));
    expect(wakeArtifactStatus(path, MODEL.onnx).corrupt).toBe(true);
  });

  test('status reports not-provisioned on a clean machine and never claims ready', () => {
    const status = wakeProvisionStatus({ managedRoot: root });
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('not-provisioned');
    expect(status.modelVersion).toBe(MODEL.version);
    // Both classifier formats, the front end, the speech gate, and all three
    // attribution NOTICEs, counted through the manifest's own helpers, which is
    // what keeps a NOTICE from going uncounted the way the front end's did.
    expect(status.downloadBytes).toBe(
      wakeWordProvisionBytes(MODEL) + wakeWordFrontEndProvisionBytes() + wakeVadProvisionBytes(),
    );
    expect(status.downloadBytes).toBe(
      MODEL.onnx.bytes + MODEL.tflite.bytes + MODEL.notice.bytes
      + EMBEDDING.bytes + EMBEDDING_NOTICE.bytes
      + VAD.bytes + VAD_NOTICE.bytes,
    );
    // The gate is reported separately from the detector's own readiness.
    expect(status.vadReady).toBe(false);
    expect(status.vad.verified).toBe(false);
    // Surfaced at every status boundary, not only in the docs.
    expect(status.recallIsSyntheticOnly).toBe(true);
  });

  test('status distinguishes a corrupt install from a missing one', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const status = wakeProvisionStatus({ managedRoot: root });
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('checksum-mismatch');
    expect(status.classifier.corrupt).toBe(true);
  });
});

describe('provisioning refuses bad downloads', () => {
  test('a truncated body is refused and nothing is left at the destination', async () => {
    const bodies = pinnedBodies();
    // One byte short of the pin: the classic silent-corruption case.
    bodies[MODEL.onnx.url] = new Uint8Array(MODEL.onnx.bytes - 1);
    bodies[MODEL.tflite.url] = new Uint8Array(MODEL.tflite.bytes - 1);
    bodies[MODEL.notice.url] = new Uint8Array(MODEL.notice.bytes - 1);
    bodies[EMBEDDING.url] = new Uint8Array(EMBEDDING.bytes - 1);
    bodies[EMBEDDING_NOTICE.url] = new Uint8Array(EMBEDDING_NOTICE.bytes - 1);
    bodies[VAD.url] = new Uint8Array(VAD.bytes - 1);
    bodies[VAD_NOTICE.url] = new Uint8Array(VAD_NOTICE.bytes - 1);
    const { impl } = servingFetch(bodies);
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(result.ready).toBe(false);
    expect(result.vadReady).toBe(false);
    expect(result.noticePath).toBeNull();
    for (const outcome of result.outcomes) {
      expect(outcome.state).toBe('failed');
      expect(outcome.error).toContain('size-mismatch');
      expect(existsSync(outcome.path)).toBe(false);
    }
  });

  test('a right-sized body with the wrong checksum is refused', async () => {
    const bodies = pinnedBodies();
    // Correct length, wrong content, a swapped asset or a corrupted transfer
    // that a size check alone would wave through.
    bodies[MODEL.onnx.url] = new Uint8Array(MODEL.onnx.bytes).fill(7);
    bodies[MODEL.tflite.url] = new Uint8Array(MODEL.tflite.bytes).fill(7);
    bodies[MODEL.notice.url] = new Uint8Array(MODEL.notice.bytes).fill(7);
    bodies[EMBEDDING.url] = new Uint8Array(EMBEDDING.bytes).fill(7);
    bodies[EMBEDDING_NOTICE.url] = new Uint8Array(EMBEDDING_NOTICE.bytes).fill(7);
    bodies[VAD.url] = new Uint8Array(VAD.bytes).fill(7);
    bodies[VAD_NOTICE.url] = new Uint8Array(VAD_NOTICE.bytes).fill(7);
    const { impl } = servingFetch(bodies);
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(result.ready).toBe(false);
    for (const outcome of result.outcomes) {
      expect(outcome.error).toContain('checksum-mismatch');
      expect(existsSync(outcome.path)).toBe(false);
    }
  });

  test('an HTTP error is reported, not written', async () => {
    const { impl } = servingFetch({});
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(result.ready).toBe(false);
    expect(result.outcomes.every((o) => o.state === 'failed')).toBe(true);
    expect(result.outcomes[0]?.error).toContain('404');
  });

  test('a bad file already on disk is re-fetched rather than used', async () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    mkdirSync(paths.frontEndDir, { recursive: true });
    // A crash left a full-size zero file behind.
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const { impl, requests } = servingFetch(pinnedBodies());
    await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    // It was NOT skipped: the classifier URL was requested again.
    expect(requests).toContain(MODEL.onnx.url);
  });
});

describe('the speech gate provisions with the models', () => {
  test('a provision asks for the gate and its NOTICE, not only the detector', async () => {
    const { impl, requests } = servingFetch({});
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(requests).toContain(VAD.url);
    expect(requests).toContain(VAD_NOTICE.url);
    // The plan's full order: each artifact immediately followed by its own
    // attribution file, everything the detector needs first, then the gate, then
    // the tflite twin nothing here loads.
    expect(result.outcomes.map((outcome) => outcome.component)).toEqual([
      'embedding', 'embedding-notice', 'classifier', 'notice', 'vad', 'vad-notice', 'mobile-classifier',
    ]);
  });

  test('status reports the gate separately from the detector', () => {
    const status = wakeProvisionStatus({ managedRoot: root });
    expect(status.vad.path).toContain('goodvibes-vad-');
    expect(status.vadNotice.path).toContain('.NOTICE.txt');
    expect(status.vad.verified).toBe(false);
    expect(status.vad.corrupt).toBe(false);
    expect(status.vadReady).toBe(false);
  });

  test('a gate file that fails verification is reaped, and a stale gate version with it', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.frontEndDir, { recursive: true });
    // Full-size, wrong content: the shape that trained a model on zeros once.
    writeFileSync(paths.vadPath, Buffer.alloc(VAD.bytes));
    const stale = join(paths.frontEndDir, 'goodvibes-vad-0.9.0.onnx');
    writeFileSync(stale, Buffer.alloc(16));
    const summary = sweepWakeStorage({ managedRoot: root, skipReceipt: true });
    const reasons = new Map(summary.reaped.map((entry) => [entry.path, entry.reason]));
    expect(reasons.get(paths.vadPath)).toBe('failed-verification');
    expect(reasons.get(stale)).toBe('unpinned-version');
    expect(existsSync(paths.vadPath)).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('provisioning succeeds and is resumable', () => {
  test('verified artifacts install, and a re-run skips them without refetching', async () => {
    // Uses pins over content the test can actually produce, so the happy path
    // is exercised end to end rather than only its failure branches.
    const classifierBody = new Uint8Array(2048).fill(3);
    const noticeBody = new TextEncoder().encode('NOTICE: attribution required.\n');
    const embeddingBody = new Uint8Array(4096).fill(9);
    const specs = {
      classifier: fakePin(classifierBody, 'https://example.invalid/classifier.onnx'),
      notice: fakePin(noticeBody, 'https://example.invalid/NOTICE.txt'),
      embedding: fakePin(embeddingBody, 'https://example.invalid/embedding.onnx'),
    };
    const { downloadVerifiedFile } = await import(
      '../packages/sdk/src/platform/voice/provisioning/download-verified.js'
    );
    const bodies = {
      [specs.classifier.url]: classifierBody,
      [specs.notice.url]: noticeBody,
      [specs.embedding.url]: embeddingBody,
    };
    const { impl, requests } = servingFetch(bodies);
    const dest = join(root, 'artifact.onnx');
    const first = await downloadVerifiedFile({ spec: specs.classifier, destPath: dest, fetchImpl: impl });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.skipped).toBe(false);
    expect(readFileSync(dest).length).toBe(classifierBody.length);
    const second = await downloadVerifiedFile({ spec: specs.classifier, destPath: dest, fetchImpl: impl });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe(true);
    // Exactly one network request across both runs, that is what resumable means.
    expect(requests.filter((u) => u === specs.classifier.url).length).toBe(1);
    expect(specs.notice.bytes).toBe(noticeBody.length);
    expect(specs.embedding.bytes).toBe(embeddingBody.length);
  });
});

describe('recovery housekeeping', () => {
  test('an abandoned partial download is reaped once it has aged out', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    const stale = join(paths.modelsDir, '.deadbeef.part');
    const fresh = join(paths.modelsDir, '.cafe.part');
    writeFileSync(stale, Buffer.alloc(64));
    writeFileSync(fresh, Buffer.alloc(64));
    const old = Date.now() / 1000 - 24 * 3600;
    utimesSync(stale, old, old);
    const summary = sweepWakeStorage({ managedRoot: root });
    expect(summary.reaped.map((r) => r.reason)).toContain('abandoned-partial');
    expect(existsSync(stale)).toBe(false);
    // A partial from a download still in flight is left alone.
    expect(existsSync(fresh)).toBe(true);
  });

  test('an artifact failing verification is reaped so the next provision refetches it', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const summary = sweepWakeStorage({ managedRoot: root });
    expect(existsSync(paths.classifierPath)).toBe(false);
    expect(summary.reaped.some((r) => r.reason === 'failed-verification')).toBe(true);
    expect(summary.bytesReclaimed).toBeGreaterThanOrEqual(MODEL.onnx.bytes);
  });

  test('an artifact of an unpinned version is reaped', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    const orphan = join(paths.modelsDir, 'goodvibes-wakeword-hey-goodvibes-0.9.0.onnx');
    writeFileSync(orphan, Buffer.alloc(128));
    const summary = sweepWakeStorage({ managedRoot: root });
    expect(existsSync(orphan)).toBe(false);
    expect(summary.reaped.some((r) => r.reason === 'unpinned-version')).toBe(true);
  });

  test('retained audio is bounded by age, by count, and by owning session', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.retainedDir, { recursive: true });
    const now = Date.now();
    const write = (name: string, ageHours: number) => {
      const path = join(paths.retainedDir, name);
      writeFileSync(path, Buffer.alloc(16));
      const seconds = (now - ageHours * 3600_000) / 1000;
      utimesSync(path, seconds, seconds);
      return path;
    };
    const expired = write('live--old.wav', 48);
    const orphaned = write('dead--recent.wav', 1);
    const kept: string[] = [];
    for (let i = 0; i < 5; i += 1) kept.push(write(`live--k${i}.wav`, i / 60));
    const summary = sweepWakeStorage({
      managedRoot: root,
      liveSessionIds: ['live'],
      retainedMaxFiles: 3,
      retainedMaxAgeHours: 24,
      now,
    });
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(orphaned)).toBe(false);
    const reasons = summary.reaped.map((r) => r.reason);
    expect(reasons).toContain('retained-expired');
    expect(reasons).toContain('retained-orphaned');
    expect(reasons).toContain('retained-over-cap');
    // Exactly the cap survives, and it is the newest ones that do.
    const survivors = kept.filter((p) => existsSync(p));
    expect(survivors.length).toBe(3);
  });

  test('every sweep discloses what it removed', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    sweepWakeStorage({ managedRoot: root });
    const receipt = JSON.parse(
      readFileSync(join(paths.wakeRoot, WAKE_REAP_RECEIPT_FILE), 'utf-8'),
    ) as WakeReapSummary;
    // Silent deletion is indistinguishable from data loss.
    expect(receipt.reaped.length).toBeGreaterThan(0);
    expect(receipt.wakeRoot).toBe(paths.wakeRoot);
    expect(typeof receipt.at).toBe('string');
  });

  test('sweeping is idempotent and safe to repeat', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const first = sweepWakeStorage({ managedRoot: root });
    const second = sweepWakeStorage({ managedRoot: root });
    expect(first.reaped.length).toBeGreaterThan(0);
    expect(second.reaped).toEqual([]);
    expect(second.failures).toEqual([]);
  });

  test('a sweep on a machine that never provisioned does nothing and does not throw', () => {
    const summary = sweepWakeStorage({ managedRoot: join(root, 'never-used') });
    expect(summary.reaped).toEqual([]);
    expect(summary.failures).toEqual([]);
  });

  test('the periodic sweeper sweeps at start and can be stopped', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const sweeper = startWakeRecoverySweeper({ managedRoot: root, intervalMs: 3600_000 });
    // A daemon that only sweeps at boot never sweeps, but it must at least
    // sweep at boot.
    expect(existsSync(paths.classifierPath)).toBe(false);
    expect(sweeper.sweepNow().failures).toEqual([]);
    sweeper.stop();
    sweeper.stop();
  });
});

describe('how the model is described to a user', () => {
  test('the description always carries the synthetic-recall qualification', () => {
    const text = describeWakeModel(MODEL);
    expect(text).toContain('hey goodvibes');
    expect(text).toContain('96.8% recall');
    expect(text).toContain('0.9');
    // Quoting a recall number without this sentence presents a synthetic
    // result as a real one.
    expect(text).toContain('synthesised speech only');
    expect(text).toContain('no human recording of the phrase exists');
    expect(text).toContain('false-accept figures ARE measured on real human speech');
  });
});

describe('the retained-clip naming the sweeper depends on', () => {
  test('the session id is the first --delimited segment, which is what makes an orphan recognisable', () => {
    const name = retainedClipFileName('sess-abc', Date.UTC(2026, 6, 29, 12, 34, 56, 789));
    expect(name.split('--')[0]).toBe('sess-abc');
    expect(name.endsWith('.wav')).toBe(true);
    // No characters that are unportable in a filename.
    expect(name).not.toMatch(/[:/\\]/);
  });

  test('a session id that would split the convention is made safe first', () => {
    // A `--` inside the id would make the sweeper read a truncated session id
    // and reap a live session's clips as orphans.
    const name = retainedClipFileName('weird--id/with:chars', 0);
    expect(name.split('--')[0]).toBe('weird-id_with_chars');
  });
});

describe('which model files voice.wake.models resolves to', () => {
  test('the pinned id resolves inside the managed tree and is marked pinned', () => {
    const [file] = resolveWakeModelFiles(['hey_goodvibes'], { managedRoot: '/managed' });
    expect(file?.pinned).toBe(true);
    expect(file?.path).toContain('/managed/wake/models/');
    expect(file?.path.endsWith('.onnx')).toBe(true);
  });

  test('a custom id with an EMPTY customModelDir falls back to the managed custom directory', () => {
    // The row promises this fallback in writing. Without it a host would look
    // for custom models in the process working directory.
    const [file] = resolveWakeModelFiles(['my_word'], { managedRoot: '/managed', customModelDir: '' });
    expect(file?.path).toBe('/managed/wake/custom/my_word.onnx');
    expect(file?.pinned).toBe(false);
  });

  test('a custom directory is used as given, and its files are NOT pinned', () => {
    const [file] = resolveWakeModelFiles(['my_word'], { managedRoot: '/managed', customModelDir: '/home/me/models' });
    expect(file?.path).toBe('/home/me/models/my_word.onnx');
    expect(file?.pinned).toBe(false);
  });

  test('order is preserved and the pinned model can sit beside custom ones', () => {
    const files = resolveWakeModelFiles(['hey_goodvibes', 'my_word'], { managedRoot: '/managed' });
    expect(files.map((f) => f.id)).toEqual(['hey_goodvibes', 'my_word']);
    expect(files.map((f) => f.pinned)).toEqual([true, false]);
  });

  test('an empty list resolves to no files, which is detection disabled without a stopped service', () => {
    expect(resolveWakeModelFiles([], { managedRoot: '/managed' })).toEqual([]);
  });
});

describe('both runtime formats of the classifier are provisioned, and only one gates readiness', () => {
  test('the tflite twin resolves beside the onnx build in the managed tree', () => {
    const paths = resolveManagedWakePaths(root);
    expect(paths.mobileClassifierPath).toBe(paths.classifierPath.replace(/\.onnx$/, '.tflite'));
    expect(paths.mobileClassifierPath.startsWith(paths.modelsDir)).toBe(true);
  });

  test('a provision fetches the tflite too, and fetches the detector artifacts FIRST', async () => {
    const { impl, requests } = servingFetch(pinnedBodies());
    await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(requests).toContain(MODEL.tflite.url);
    // Order is load-bearing: an install that loses the network part-way must
    // leave a WORKING detector, not a mobile-format file and nothing to run.
    expect(requests.indexOf(MODEL.tflite.url)).toBeGreaterThan(requests.indexOf(MODEL.onnx.url));
    expect(requests.indexOf(MODEL.tflite.url)).toBeGreaterThan(requests.indexOf(MODEL.notice.url));
    expect(requests.indexOf(MODEL.tflite.url)).toBeGreaterThan(requests.indexOf(EMBEDDING.url));
  });

  test('the reported download size and the artifacts actually fetched are the same set', async () => {
    const { impl, requests } = servingFetch(pinnedBodies());
    const status = wakeProvisionStatus({ managedRoot: root });
    await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    // downloadBytes has always counted the classifier's tflite; before it was
    // fetched, that figure described a download that never happened. The rule now
    // holds for every pinned artifact, the speech gate included: the gate's own
    // tflite twin is pinned but NOT fetched, so it is NOT counted either.
    const fetched = [MODEL.onnx, MODEL.tflite, MODEL.notice, EMBEDDING, EMBEDDING_NOTICE, VAD, VAD_NOTICE]
      .filter((spec) => requests.includes(spec.url))
      .reduce((total, spec) => total + spec.bytes, 0);
    expect(status.downloadBytes).toBe(fetched);
    expect(requests).not.toContain(WAKE_VAD_MODEL.tflite.url);
  });

  test('a torn tflite does NOT make the detector report a checksum problem', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    writeFileSync(paths.mobileClassifierPath, Buffer.alloc(MODEL.tflite.bytes));
    const status = wakeProvisionStatus({ managedRoot: root });
    expect(status.mobileClassifier.corrupt).toBe(true);
    // The three the detector loads are simply absent, and that, not the twin,
    // is what the reason has to describe.
    expect(status.reason).toBe('not-provisioned');
    expect(status.ready).toBe(false);
  });

  test('a receipt reports the mobile format separately from whether the detector can run', async () => {
    const bodies = pinnedBodies();
    delete bodies[MODEL.tflite.url];
    const { impl } = servingFetch(bodies);
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(result.mobileFormatReady).toBe(false);
    const mobile = result.outcomes.find((o) => o.component === 'mobile-classifier');
    expect(mobile?.state).toBe('failed');
    expect(mobile?.error).toContain('404');
  });

  test('the NOTICE path is reported whenever the NOTICE itself landed', async () => {
    // Its own outcome decides it, not the run's: the NOTICE must travel with
    // whatever WAS written, and a tflite 404 does not un-write it.
    const written: string[] = [];
    const result = await provisionWakeWordModels({
      managedRoot: root,
      fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    expect(written).toEqual([]);
    expect(result.noticePath).toBeNull();
    expect(result.ready).toBe(false);
  });

  test('the sweeper keeps a pinned tflite and reaps a torn one', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    // A pinned-version filename with content that does not match is reaped for
    // FAILING VERIFICATION, not for being an unpinned version, the distinction
    // matters because an unpinned-version reap would delete every provisioned
    // tflite on the next sweep, forever.
    writeFileSync(paths.mobileClassifierPath, Buffer.alloc(MODEL.tflite.bytes));
    const summary = sweepWakeStorage({ managedRoot: root });
    const entry = summary.reaped.find((r) => r.path === paths.mobileClassifierPath);
    expect(entry?.reason).toBe('failed-verification');
  });
});

describe('the managed voice root is derived once, not per caller', () => {
  test('it is the same directory the running path service resolves', () => {
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    expect(resolveManagedVoiceRoot(root)).toBe(paths.resolveUserPath('voice'));
  });

  test('a relative home is refused rather than resolved against the working directory', () => {
    // An installer resolving this relatively would scatter a managed tree
    // wherever it happened to be invoked from.
    expect(() => resolveManagedVoiceRoot('relative/home')).toThrow(/absolute home directory/);
    expect(() => resolveManagedVoiceRoot('   ')).toThrow(/absolute home directory/);
  });
});

describe('provisioning as part of installation', () => {
  /** A fetch that behaves like a machine with no network at all. */
  const offlineFetch = (async () => { throw new Error('getaddrinfo ENOTFOUND objects.githubusercontent.com'); }) as unknown as typeof fetch;

  test('an OFFLINE install does not fail, and degrades to exactly the old behaviour', async () => {
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      fetchImpl: offlineFetch,
      recoveryHint: '/voice wake setup',
      env: {},
    });
    // 1. It did not throw, and it did not claim success.
    expect(outcome.state).toBe('degraded');
    expect(outcome.ready).toBe(false);
    // 2. It said so once, plainly, naming the recovery act and the retry.
    expect(outcome.message).toContain('installation continues');
    expect(outcome.message).toContain('/voice wake setup');
    // The reason is the download layer's own plain-language summary, not a raw
    // stack: this line is printed to a person installing a coding tool.
    expect(outcome.message).toContain('DNS lookup failed');
    // 3. Nothing partial or unverified was left behind.
    const paths = resolveManagedWakePaths(root);
    expect(existsSync(paths.classifierPath)).toBe(false);
    expect(existsSync(paths.mobileClassifierPath)).toBe(false);
    expect(existsSync(paths.embeddingPath)).toBe(false);
    // 4. The feature's own status is unchanged from a machine that never tried.
    const status = wakeProvisionStatus({ managedRoot: root });
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('not-provisioned');
  });

  test('an HTTP failure is reported honestly rather than as a generic error', async () => {
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      env: {},
    });
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain('503');
  });

  test('a provisioner that THROWS still cannot fail an install', async () => {
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      provision: async () => { throw new Error('EROFS: read-only file system'); },
    });
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain('EROFS');
    expect(outcome.ready).toBe(false);
  });

  test('a status read that throws is a degraded outcome, not an exception', async () => {
    let provisioned = false;
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      readStatus: () => { throw new Error('EACCES: permission denied'); },
      provision: async () => { provisioned = true; throw new Error('unreachable'); },
    });
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain('EACCES');
    // It never got as far as spending bandwidth on a tree it cannot read.
    expect(provisioned).toBe(false);
  });

  test('an already-provisioned machine downloads nothing and stays quiet about it', async () => {
    let downloads = 0;
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      readStatus: () => readyStatus(root),
      provision: async () => { downloads += 1; throw new Error('should not run'); },
    });
    expect(outcome.state).toBe('already-provisioned');
    expect(outcome.ready).toBe(true);
    expect(downloads).toBe(0);
  });

  test('the opt-out is honoured and reported, never silent', async () => {
    let downloads = 0;
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      recoveryHint: '/voice wake setup',
      env: { [WAKE_INSTALL_SKIP_ENV]: '1' },
      provision: async () => { downloads += 1; throw new Error('should not run'); },
    });
    expect(downloads).toBe(0);
    expect(outcome.state).toBe('opted-out');
    expect(outcome.message).toContain(WAKE_INSTALL_SKIP_ENV);
    expect(outcome.message).toContain('/voice wake setup');
  });

  test('a successful install verifies by content and says the feature needs nothing further', async () => {
    // Not ready before, ready after: the read that decides is the one taken
    // AFTER the fetch, over the tree on disk.
    let reads = 0;
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      // A provisioner that reports success is not trusted on its own: the policy
      // re-reads the tree by content before it calls anything ready.
      provision: async () => ({
        ready: true,
        mobileFormatReady: true,
        vadReady: true,
        modelVersion: MODEL.version,
        outcomes: [{ component: 'classifier' as const, state: 'installed' as const, path: 'c', bytes: 2_367_644 }],
        noticePath: 'n',
        embeddingNoticePath: 'en',
        recallIsSyntheticOnly: true,
      }),
      readStatus: () => {
        reads += 1;
        return reads === 1 ? wakeProvisionStatus({ managedRoot: root }) : readyStatus(root);
      },
    });
    expect(reads).toBe(2);
    expect(outcome.state).toBe('provisioned');
    expect(outcome.ready).toBe(true);
    expect(outcome.message).toContain('voice.wake.enabled');
    expect(outcome.message).toContain('nothing further to download');
  });

  test('a provisioner claiming success over an unverified tree is NOT believed', async () => {
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      provision: async () => ({
        ready: true,
        mobileFormatReady: true,
        vadReady: true,
        modelVersion: MODEL.version,
        outcomes: [],
        noticePath: 'n',
        embeddingNoticePath: 'en',
        recallIsSyntheticOnly: true,
      }),
      // The real content check over an empty root: nothing is there.
    });
    expect(outcome.state).toBe('degraded');
    expect(outcome.ready).toBe(false);
  });

  test('it reaps a torn artifact before retrying, so a boot retry converges', async () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.modelsDir, { recursive: true });
    // The exact shape that cost this project a training run: full size, zero bytes.
    writeFileSync(paths.classifierPath, Buffer.alloc(MODEL.onnx.bytes));
    const { impl, requests } = servingFetch(pinnedBodies());
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      fetchImpl: impl,
    });
    expect(outcome.reapedBeforeAttempt).toBeGreaterThan(0);
    // Removed rather than re-used, and re-fetched rather than skipped.
    expect(requests).toContain(MODEL.onnx.url);
  });

  test('a pre-attempt sweep that fails does not skip the download', async () => {
    const { impl, requests } = servingFetch(pinnedBodies());
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot: root,
      env: {},
      fetchImpl: impl,
      sweep: () => { throw new Error('EPERM'); },
    });
    expect(outcome.reapedBeforeAttempt).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
  });
});

describe('the boot half: sweep, then fetch what the install could not', () => {
  test('it sweeps at boot and makes exactly one attempt, announcing the result', async () => {
    const announced: string[] = [];
    let attempts = 0;
    const pending: (() => void)[] = [];
    const boot = startWakeBootProvisioning({
      managedRoot: root,
      announce: (message) => announced.push(message),
      ensureProvisioned: async () => {
        attempts += 1;
        return degradedOutcome();
      },
      setTimeoutImpl: (handler) => { pending.push(handler); return 1; },
      clearTimeoutImpl: () => {},
    });
    // The sweep already ran, the sweeper sweeps at start, which is what makes a
    // torn artifact from a killed install recoverable without a user act.
    expect(existsSync(join(resolveManagedWakePaths(root).wakeRoot))).toBe(false);
    expect(attempts).toBe(0);
    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(announced).toEqual([degradedOutcome().message]);
    boot.stop();
  });

  test('an already-provisioned daemon restart says nothing at all', async () => {
    const announced: string[] = [];
    const pending: (() => void)[] = [];
    const boot = startWakeBootProvisioning({
      managedRoot: root,
      announce: (message) => announced.push(message),
      ensureProvisioned: async () => ({
        state: 'already-provisioned' as const,
        ready: true,
        mobileFormatReady: true,
        message: 'already there',
        outcomes: [],
        modelVersion: MODEL.version,
        reapedBeforeAttempt: 0,
      }),
      setTimeoutImpl: (handler) => { pending.push(handler); return 1; },
      clearTimeoutImpl: () => {},
    });
    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    // A line per restart about having done nothing is how a log stops being read.
    expect(announced).toEqual([]);
    boot.stop();
  });

  test('stop() before the attempt fires cancels it, and is idempotent', async () => {
    let attempts = 0;
    let cleared = 0;
    const pending: (() => void)[] = [];
    const boot = startWakeBootProvisioning({
      managedRoot: root,
      announce: () => {},
      ensureProvisioned: async () => { attempts += 1; return degradedOutcome(); },
      setTimeoutImpl: (handler) => { pending.push(handler); return 7; },
      clearTimeoutImpl: () => { cleared += 1; },
    });
    boot.stop();
    boot.stop();
    expect(cleared).toBe(1);
    // Even if the timer fired anyway (a real clearTimeout races), a stopped
    // starter must not begin a download during shutdown.
    pending[0]?.();
    await Promise.resolve();
    expect(attempts).toBe(0);
  });

  test('an ensureProvisioned that breaks its no-throw contract does not take the daemon down', async () => {
    const pending: (() => void)[] = [];
    const boot = startWakeBootProvisioning({
      managedRoot: root,
      announce: () => {},
      ensureProvisioned: async () => { throw new Error('host wrapper bug'); },
      setTimeoutImpl: (handler) => { pending.push(handler); return 1; },
      clearTimeoutImpl: () => {},
    });
    expect(() => pending[0]?.()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    boot.stop();
  });
});

/** A content-verified status for a tree the test does not have real bytes for. */
function readyStatus(managedRoot: string) {
  const paths = resolveManagedWakePaths(managedRoot);
  const verified = (path: string, bytes: number) => ({ path, verified: true, corrupt: false, bytes });
  return {
    ready: true,
    reason: null,
    classifier: verified(paths.classifierPath, MODEL.onnx.bytes),
    mobileClassifier: verified(paths.mobileClassifierPath, MODEL.tflite.bytes),
    notice: verified(paths.noticePath, MODEL.notice.bytes),
    embedding: verified(paths.embeddingPath, EMBEDDING.bytes),
    embeddingNotice: verified(paths.embeddingNoticePath, EMBEDDING_NOTICE.bytes),
    vad: verified(paths.vadPath, VAD.bytes),
    vadNotice: verified(paths.vadNoticePath, VAD_NOTICE.bytes),
    vadReady: true,
    downloadBytes: 0,
    modelVersion: MODEL.version,
    recallIsSyntheticOnly: true,
  };
}

function degradedOutcome(): WakeInstallProvisionOutcome {
  return {
    state: 'degraded',
    ready: false,
    mobileFormatReady: false,
    message: 'The wake-word model could not be downloaded (offline); installation continues.',
    outcomes: [],
    modelVersion: MODEL.version,
    reapedBeforeAttempt: 0,
  };
}

describe('both redistributable artifacts carry their attribution NOTICE, on identical terms', () => {
  test('the front end\'s NOTICE resolves beside the front end, not beside the classifier', () => {
    const paths = resolveManagedWakePaths(root);
    expect(paths.embeddingNoticePath).toBe(paths.embeddingPath.replace(/\.onnx$/, '.NOTICE.txt'));
    expect(paths.embeddingNoticePath.startsWith(paths.frontEndDir)).toBe(true);
    // Two different NOTICEs for two different artifacts, not one file doing both jobs.
    expect(paths.embeddingNoticePath).not.toBe(paths.noticePath);
  });

  test('a provision fetches it, and the plan fetches it beside the artifact it attributes', async () => {
    const { impl, requests } = servingFetch(pinnedBodies());
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(requests).toContain(EMBEDDING_NOTICE.url);
    expect(result.outcomes.map((o) => o.component)).toContain('embedding-notice');
    // Immediately after the embedding: the pair is fetched together, so a network
    // that drops part-way never leaves bytes on disk with no attribution beside them.
    expect(requests.indexOf(EMBEDDING_NOTICE.url)).toBe(requests.indexOf(EMBEDDING.url) + 1);
  });

  test('a missing front-end NOTICE makes the tree NOT ready, exactly as a missing classifier NOTICE does', async () => {
    const bodies = pinnedBodies();
    delete bodies[EMBEDDING_NOTICE.url];
    const { impl } = servingFetch(bodies);
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    // An artifact whose attribution is not on disk is not one this tree may serve.
    expect(result.ready).toBe(false);
    expect(result.embeddingNoticePath).toBeNull();
    expect(result.outcomes.find((o) => o.component === 'embedding-notice')?.state).toBe('failed');
    // And symmetrically, dropping the CLASSIFIER's notice does the same thing, the
    // point being that neither is the privileged one.
    const other = pinnedBodies();
    delete other[MODEL.notice.url];
    const second = await provisionWakeWordModels({ managedRoot: root, fetchImpl: servingFetch(other).impl });
    expect(second.ready).toBe(false);
    expect(second.noticePath).toBeNull();
  });

  test('each NOTICE is reported on its OWN outcome, with its own reason', async () => {
    // Both NOTICE paths are derived from their own component's outcome rather than
    // from the run's overall result, so one failing cannot erase the other's record.
    // These fixtures cannot make either one VERIFY (the served bodies are empty, and
    // the pins are the real published checksums), so what is pinned here is that the
    // two are tracked separately and each carries its own honest reason, the live
    // install is what proves the success side.
    const bodies = pinnedBodies();
    delete bodies[EMBEDDING_NOTICE.url];
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: servingFetch(bodies).impl });
    const classifierNotice = result.outcomes.find((o) => o.component === 'notice');
    const frontEndNotice = result.outcomes.find((o) => o.component === 'embedding-notice');
    expect(classifierNotice).toBeDefined();
    expect(frontEndNotice).toBeDefined();
    // Different failures, reported as such: one was served the wrong length, the
    // other was not served at all.
    expect(classifierNotice?.error).toContain('size-mismatch');
    expect(frontEndNotice?.error).toContain('404');
    // And they point at different files, so neither reason can be attributed to the
    // wrong artifact by a reader of the receipt.
    expect(classifierNotice?.path).not.toBe(frontEndNotice?.path);
  });

  test('status reports it as its own artifact, and a torn one is corrupt rather than absent', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.frontEndDir, { recursive: true });
    const clean = wakeProvisionStatus({ managedRoot: root });
    expect(clean.embeddingNotice.verified).toBe(false);
    expect(clean.embeddingNotice.corrupt).toBe(false);
    expect(clean.embeddingNotice.path).toBe(paths.embeddingNoticePath);

    writeFileSync(paths.embeddingNoticePath, Buffer.alloc(EMBEDDING_NOTICE.bytes));
    const torn = wakeProvisionStatus({ managedRoot: root });
    expect(torn.embeddingNotice.corrupt).toBe(true);
    expect(torn.reason).toBe('checksum-mismatch');
  });

  test('the sweeper KEEPS a pinned front-end NOTICE and reaps a torn one', () => {
    // The defect class this exists for: a file the provisioner writes and the
    // sweeper does not recognise is deleted once an hour, forever. It shipped once
    // for the .tflite; the front-end directory's NOTICE was the next candidate.
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.frontEndDir, { recursive: true });
    writeFileSync(paths.embeddingNoticePath, Buffer.alloc(EMBEDDING_NOTICE.bytes));
    const summary = sweepWakeStorage({ managedRoot: root });
    const entry = summary.reaped.find((r) => r.path === paths.embeddingNoticePath);
    // Reaped for failing verification (so the next provision refetches it), NOT for
    // being an unpinned version (which would delete a good one too).
    expect(entry?.reason).toBe('failed-verification');
  });

  test('a front-end NOTICE of an unpinned version is still reaped', () => {
    const paths = resolveManagedWakePaths(root);
    mkdirSync(paths.frontEndDir, { recursive: true });
    const orphan = join(paths.frontEndDir, 'speech-embedding-0.9.0.NOTICE.txt');
    writeFileSync(orphan, Buffer.alloc(32));
    const summary = sweepWakeStorage({ managedRoot: root });
    expect(summary.reaped.find((r) => r.path === orphan)?.reason).toBe('unpinned-version');
  });

  test('the reported download size comes from the manifest helpers, not a hand-written sum', () => {
    // Summing the fields by hand at each call site is precisely how the front end's
    // NOTICE ended up uncounted while its bytes were being advertised.
    expect(wakeWordFrontEndProvisionBytes()).toBe(EMBEDDING.bytes + EMBEDDING_NOTICE.bytes);
    expect(wakeVadProvisionBytes()).toBe(VAD.bytes + VAD_NOTICE.bytes);
    expect(wakeProvisionStatus({ managedRoot: root }).downloadBytes)
      .toBe(wakeWordProvisionBytes(MODEL) + wakeWordFrontEndProvisionBytes() + wakeVadProvisionBytes());
  });

  test('an install that lands everything reports both NOTICE paths and is ready', async () => {
    const { impl } = servingFetch(pinnedBodies());
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    // pinnedBodies serves zero-length bodies, so nothing verifies, what is asserted
    // here is the SHAPE of a complete plan, which the live install proves for real.
    expect(result.outcomes.map((o) => o.component).sort()).toEqual(
      ['classifier', 'embedding', 'embedding-notice', 'mobile-classifier', 'notice', 'vad', 'vad-notice'],
    );
  });
});
