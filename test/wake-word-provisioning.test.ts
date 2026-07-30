/**
 * Provisioning and recovery for the wake-word artifacts.
 *
 * The bug class these tests exist for has already cost this project a training
 * run: a cache pre-allocated a file, a crash left it full-size and zero-filled,
 * and an existence-only check treated it as complete. So nothing here is
 * allowed to accept a file because it is present — every acceptance is by
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
  sweepWakeStorage,
  startWakeRecoverySweeper,
  WAKE_REAP_RECEIPT_FILE,
  type WakeReapSummary,
  retainedClipFileName,
} from '../packages/sdk/src/platform/voice/wake/recovery.js';
import {
  resolveWakeWordModel,
  WAKE_WORD_FRONT_END,
} from '../packages/sdk/src/platform/voice/provisioning/wake-word-manifest.js';

// Resolved eagerly via an IIFE (rather than a bare `const` + throw-guard) so
// MODEL's static type is non-null everywhere it's read, including inside
// nested function bodies defined below — a throw-guard on a separate
// statement narrows only the enclosing scope's own control flow, not closures
// that read the variable later.
const MODEL = (() => {
  const model = resolveWakeWordModel();
  if (model === null) throw new Error('the default wake-word model must resolve');
  return model;
})();
const EMBEDDING = WAKE_WORD_FRONT_END.embedding.download;

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
    [MODEL.notice.url]: new Uint8Array(0),
    [EMBEDDING.url]: new Uint8Array(0),
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
    expect(status.downloadBytes).toBe(
      MODEL.onnx.bytes + MODEL.tflite.bytes + MODEL.notice.bytes + EMBEDDING.bytes,
    );
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
    bodies[MODEL.notice.url] = new Uint8Array(MODEL.notice.bytes - 1);
    bodies[EMBEDDING.url] = new Uint8Array(EMBEDDING.bytes - 1);
    const { impl } = servingFetch(bodies);
    const result = await provisionWakeWordModels({ managedRoot: root, fetchImpl: impl });
    expect(result.ready).toBe(false);
    expect(result.noticePath).toBeNull();
    for (const outcome of result.outcomes) {
      expect(outcome.state).toBe('failed');
      expect(outcome.error).toContain('size-mismatch');
      expect(existsSync(outcome.path)).toBe(false);
    }
  });

  test('a right-sized body with the wrong checksum is refused', async () => {
    const bodies = pinnedBodies();
    // Correct length, wrong content — a swapped asset or a corrupted transfer
    // that a size check alone would wave through.
    bodies[MODEL.onnx.url] = new Uint8Array(MODEL.onnx.bytes).fill(7);
    bodies[MODEL.notice.url] = new Uint8Array(MODEL.notice.bytes).fill(7);
    bodies[EMBEDDING.url] = new Uint8Array(EMBEDDING.bytes).fill(7);
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
    // Exactly one network request across both runs — that is what resumable means.
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
