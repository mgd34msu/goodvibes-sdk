/**
 * optional-dependency-boot.test.ts — an optional package that is not there
 * must not take the process with it.
 *
 * ── What this measures ────────────────────────────────────────────────────
 *
 * `packages/sdk/package.json` declares thirty packages under
 * `optionalDependencies`. That is a promise that an install without them still
 * produces a working SDK. `knowledge/html-readability.ts` broke the promise for
 * every graph that reaches knowledge extraction — the daemon's included —
 * because it imported `jsdom` and `@mozilla/readability` statically.
 *
 * Measured in this repository with `packages/sdk/node_modules/jsdom` moved
 * aside, before the fix:
 *
 *   bun build packages/sdk/src/platform/daemon/cli.ts --compile
 *     → error: Could not resolve: "jsdom"   (no daemon binary at all)
 *
 *   the same graph run from source
 *     → Cannot find package 'jsdom'         (dies at module init: before
 *       main(), before the activity logger has a destination, and before
 *       daemon/fatal-boot-report.ts exists to report it)
 *
 * ── Why it compiles, and why it uses `--external` ─────────────────────────
 *
 * It compiles because a source-level test cannot see this: under `bun` with a
 * full node_modules tree, a static import and a dynamic one behave identically.
 * The artifact is where the difference lives.
 *
 * It uses `--external` rather than hiding the package, because hiding it would
 * mutate this repository's node_modules for every other test running beside
 * this one and would leave the tree broken if the process died mid-run.
 * `--external` leaves the specifier for runtime resolution and the binary is
 * then run from a directory where it does not resolve — the same condition an
 * install without optional packages produces, contained entirely inside the
 * test.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMPILE_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 30_000;
const REPO_ROOT = join(import.meta.dir, '..');

interface CompiledEntry {
  readonly binary: string;
  readonly dir: string;
}

/**
 * Compile one fixture entry, leaving the optional packages as runtime
 * specifiers so the artifact can be run in the absent condition.
 */
function compileWithExternalOptionals(entry: string, name: string): CompiledEntry {
  const dir = mkdtempSync(join(tmpdir(), `gv-optional-${name}-`));
  const binary = join(dir, name);
  const built = spawnSync(
    process.execPath,
    [
      'build', join(REPO_ROOT, entry),
      '--compile',
      '--target=bun-linux-x64',
      '--external', 'jsdom',
      '--external', '@mozilla/readability',
      '--outfile', binary,
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (built.status !== 0) {
    throw new Error(`compiling ${entry} failed (${String(built.status)}): ${built.stderr ?? ''}`);
  }
  return { binary, dir };
}

interface FixtureRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a compiled fixture from a directory with no node_modules, so the
 * externalised specifiers genuinely cannot resolve. The environment is built
 * from nothing but what is passed, so no ambient variable decides the outcome.
 */
function runWhereOptionalsAreAbsent(binary: string, cwd: string): FixtureRun {
  const result = spawnSync(binary, [], {
    cwd,
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('an absent optional dependency does not take the process down', () => {
  let lazy: CompiledEntry;
  let staticImport: CompiledEntry;
  let emptyCwd: string;

  beforeAll(() => {
    lazy = compileWithExternalOptionals('test/fixtures/optional-dependency-lazy-entry.ts', 'gv-lazy');
    staticImport = compileWithExternalOptionals('test/fixtures/optional-dependency-static-entry.ts', 'gv-static');
    emptyCwd = mkdtempSync(join(tmpdir(), 'gv-optional-cwd-'));
  });

  afterAll(() => {
    for (const dir of [lazy?.dir, staticImport?.dir, emptyCwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the static import that shipped dies before its first statement — the baseline', () => {
    const run = runWhereOptionalsAreAbsent(staticImport.binary, emptyCwd);
    expect(run.status).toBe(1);
    // Not "it printed an error and exited": it never ran at all. Zero bytes on
    // stdout with the very first statement being a write is the proof.
    expect(run.stdout).toHaveLength(0);
    expect(run.stderr).toContain("Cannot find package 'jsdom'");
  });

  test('the lazy import boots, and the feature says it is unavailable and why', () => {
    const run = runWhereOptionalsAreAbsent(lazy.binary, emptyCwd);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('INIT_SURVIVED');
    expect(run.stdout).toContain('AVAILABLE=false');
    expect(run.stdout).toContain('jsdom is not installed');
    expect(run.stdout).toContain('optional dependency of @pellux/goodvibes-sdk');
  });

  test('extraction still answers, by the lightweight path, carrying the reason', () => {
    const run = runWhereOptionalsAreAbsent(lazy.binary, emptyCwd);
    // The declaration promised the SDK works without the package. A result
    // that never arrives would not honour it, and a result that arrives with
    // no explanation for being the lesser one would be the silent-degradation
    // failure this platform treats as a defect in its own right.
    expect(run.stdout).toContain('EXTRACTOR=html');
    expect(run.stdout).toContain('TITLE=Fixture');
    expect(run.stdout).toContain('WARNING=Used the lightweight HTML fallback');
    expect(run.stdout).not.toContain('EXTRACTOR=html-readability');
  });
});

describe('the same code path with the packages installed', () => {
  test('extracts by readability and reports itself available', async () => {
    const { describeHtmlReadabilityAvailability, extractReadableHtml } =
      await import('../packages/sdk/src/platform/knowledge/html-readability.ts');
    const availability = await describeHtmlReadabilityAvailability();
    expect(availability.available).toBe(true);
    expect(availability.reason).toBeUndefined();

    const extracted = await extractReadableHtml(
      '<html><head><title>Present</title></head><body><h1>Heading</h1>'
      + '<p>Readable body text long enough for the parser to keep it.</p></body></html>',
    );
    expect(extracted).not.toBeNull();
    expect(extracted?.textContent).toContain('Readable body text');
    expect(extracted?.headings[0]).toBe('Heading');
  });

  test('the knowledge extractor picks the readability path and adds no warning', async () => {
    const { extractKnowledgeArtifact } =
      await import('../packages/sdk/src/platform/knowledge/extractors.ts');
    const result = await extractKnowledgeArtifact(
      { id: 'present', mimeType: 'text/html', filename: 'present.html' },
      Buffer.from('<html><head><title>Present</title></head><body><h1>Heading</h1>'
        + '<p>Readable body text long enough for the parser to keep it.</p></body></html>'),
    );
    expect(result.extractorId).toBe('html-readability');
    expect(result.metadata['warnings']).toBeUndefined();
  });
});
