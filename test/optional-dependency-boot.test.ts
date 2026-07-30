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

/** The extraction packages the first pair of fixtures covers. */
const EXTRACTION_OPTIONALS = ['jsdom', '@mozilla/readability'] as const;

/**
 * The client/library packages the second pair of fixtures covers: each one was
 * reached by building a client in a constructor, extending an imported base
 * class, running a class static, or re-exporting a value, and each is declared
 * under `optionalDependencies`.
 */
const CLIENT_OPTIONALS = [
  'openai',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/sdk',
  'google-auth-library',
  '@agentclientprotocol/sdk',
  'simple-git',
  'graphql',
] as const;

interface CompiledEntry {
  readonly binary: string;
  readonly dir: string;
}

/**
 * Compile one fixture entry, leaving the named optional packages as runtime
 * specifiers so the artifact can be run in the absent condition.
 */
function compileWithExternalOptionals(
  entry: string,
  name: string,
  externals: readonly string[],
): CompiledEntry {
  const dir = mkdtempSync(join(tmpdir(), `gv-optional-${name}-`));
  const binary = join(dir, name);
  const built = spawnSync(
    process.execPath,
    [
      'build', join(REPO_ROOT, entry),
      '--compile',
      '--target=bun-linux-x64',
      ...externals.flatMap((pkg) => ['--external', pkg]),
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
    lazy = compileWithExternalOptionals(
      'test/fixtures/optional-dependency-lazy-entry.ts', 'gv-lazy', EXTRACTION_OPTIONALS,
    );
    staticImport = compileWithExternalOptionals(
      'test/fixtures/optional-dependency-static-entry.ts', 'gv-static', EXTRACTION_OPTIONALS,
    );
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

describe('an absent optional client package does not take the process down', () => {
  let lazy: CompiledEntry;
  let staticImport: CompiledEntry;
  let emptyCwd: string;
  let lazyRun: FixtureRun;

  beforeAll(() => {
    lazy = compileWithExternalOptionals(
      'test/fixtures/optional-dependency-clients-lazy-entry.ts', 'gv-clients-lazy', CLIENT_OPTIONALS,
    );
    // The control is a static import of ONE of the newly converted packages,
    // compiled with the same flags and run in the same place, so the contrast
    // below is measured rather than assumed.
    staticImport = compileWithExternalOptionals(
      'test/fixtures/optional-dependency-graphql-static-entry.ts', 'gv-clients-static', CLIENT_OPTIONALS,
    );
    emptyCwd = mkdtempSync(join(tmpdir(), 'gv-optional-clients-cwd-'));
    lazyRun = runWhereOptionalsAreAbsent(lazy.binary, emptyCwd);
  });

  afterAll(() => {
    for (const dir of [lazy?.dir, staticImport?.dir, emptyCwd]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the static graphql import dies before its first statement — the baseline', () => {
    const run = runWhereOptionalsAreAbsent(staticImport.binary, emptyCwd);
    expect(run.status).toBe(1);
    // Not "it printed an error and exited": it never ran at all. Zero bytes on
    // stdout with the very first statement being a write is the proof.
    expect(run.stdout).toHaveLength(0);
    expect(run.stderr).toContain('graphql');
  });

  test('the lazy shape boots with all seven packages absent', () => {
    expect(lazyRun.status).toBe(0);
    expect(lazyRun.stdout).toContain('INIT_SURVIVED');
    expect(lazyRun.stdout).toContain('DONE');
  });

  test('openai: the provider still constructs, and the first call names the package', () => {
    expect(lazyRun.stdout).toContain('OPENAI_AVAILABLE=false');
    expect(lazyRun.stdout).toContain('OPENAI_REASON=openai is not installed');
    // Constructing the provider used to build the client, so an absent package
    // broke provider registration; now it does not.
    expect(lazyRun.stdout).toContain('OPENAI_PROVIDER_CONSTRUCTED=openai');
    expect(lazyRun.stdout).toContain('OPENAI_EMBED_THREW=');
    expect(lazyRun.stdout).toMatch(/OPENAI_EMBED_THREW=.*openai is not installed/);
  });

  test('@anthropic-ai/bedrock-sdk: unavailable by name, and the model fetch says so', () => {
    expect(lazyRun.stdout).toContain('BEDROCK_AVAILABLE=false');
    expect(lazyRun.stdout).toContain('BEDROCK_REASON=@anthropic-ai/bedrock-sdk is not installed');
    expect(lazyRun.stdout).toMatch(/BEDROCK_MODELS_THREW=.*@anthropic-ai\/bedrock-sdk/);
  });

  test('@anthropic-ai/sdk and google-auth-library: the class that extends a base built later', () => {
    expect(lazyRun.stdout).toContain('VERTEX_AVAILABLE=false');
    // Both packages are named, not just the first one missing.
    expect(lazyRun.stdout).toMatch(/VERTEX_REASON=.*@anthropic-ai\/sdk/);
    expect(lazyRun.stdout).toMatch(/VERTEX_REASON=.*google-auth-library/);
    expect(lazyRun.stdout).toMatch(/VERTEX_CLIENT_THREW=.*@anthropic-ai\/sdk/);
  });

  test('@agentclientprotocol/sdk: the re-exported values are gone, the loader reports it', () => {
    expect(lazyRun.stdout).toContain('ACP_AVAILABLE=false');
    expect(lazyRun.stdout).toContain('ACP_REASON=@agentclientprotocol/sdk is not installed');
    expect(lazyRun.stdout).toMatch(/ACP_SERVE_THREW=.*@agentclientprotocol\/sdk/);
  });

  test('simple-git: the service constructs and the first git call names the package', () => {
    expect(lazyRun.stdout).toContain('GIT_AVAILABLE=false');
    expect(lazyRun.stdout).toContain('GIT_REASON=simple-git is not installed');
    expect(lazyRun.stdout).toMatch(/GIT_STATUS_THREW=.*simple-git is not installed/);
  });

  test('graphql: the class statics that ran at module init now report by name', () => {
    expect(lazyRun.stdout).toContain('GRAPHQL_AVAILABLE=false');
    expect(lazyRun.stdout).toContain('GRAPHQL_REASON=graphql is not installed');
    expect(lazyRun.stdout).toMatch(/GRAPHQL_SCHEMA_THREW=.*graphql is not installed/);
    expect(lazyRun.stdout).toMatch(/GRAPHQL_INSPECT_THREW=.*graphql is not installed/);
  });

  test('every unavailability message points at the install that fixes it', () => {
    const reasons = lazyRun.stdout.split('\n').filter((line) => line.includes('is not installed'));
    expect(reasons.length).toBeGreaterThanOrEqual(7);
    for (const reason of reasons) {
      expect(reason).toContain('optional dependency of @pellux/goodvibes-sdk');
    }
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

  test('graphql: the lazily-built schema is the same schema, printed once', async () => {
    const { KnowledgeGraphqlService, inspectKnowledgeGraphqlAccess } =
      await import('../packages/sdk/src/platform/knowledge/graphql.ts');
    const sdl = KnowledgeGraphqlService.schemaSdl;
    expect(sdl).toContain('type KnowledgeStatus');
    expect(sdl).toContain('scalar JSON');
    // Cached, not rebuilt: the class statics this replaced were computed once.
    expect(KnowledgeGraphqlService.schemaSdl).toBe(sdl);
    // The synchronous access check the daemon-sdk route contract requires.
    expect(inspectKnowledgeGraphqlAccess('query Q { status { ready } }').operation).toBe('query');
    expect(inspectKnowledgeGraphqlAccess('mutation M { lint { code } }').adminRequired).toBe(true);
  });

  test('simple-git: the lazily-built client is built once and still runs git', async () => {
    const { GitService } = await import('../packages/sdk/src/platform/git/service.ts');
    const service = new GitService(REPO_ROOT);
    const status = await service.status();
    expect(typeof status.isClean()).toBe('boolean');
    // Memoised: the second call reuses the instance the first one built.
    const again = await service.status();
    expect(again.current).toBe(status.current);
  });

  test('openai: the provider constructs, reports itself, and resolves its client', async () => {
    const { OpenAIProvider } = await import('../packages/sdk/src/platform/providers/openai.ts');
    const { describeOpenAIAvailability } =
      await import('../packages/sdk/src/platform/providers/optional-openai.ts');
    expect((await describeOpenAIAvailability()).available).toBe(true);
    const provider = new OpenAIProvider('');
    expect(provider.isConfigured()).toBe(false);
    expect(provider.models.length).toBeGreaterThan(0);
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
