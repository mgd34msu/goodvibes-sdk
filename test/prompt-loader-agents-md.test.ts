/**
 * AGENTS.md support in the system prompt loader.
 *
 * The loader reads the project's own instruction files and now also the
 * AGENTS.md convention with nearest-file-wins semantics (walk up from the
 * working directory, closest AGENTS.md applies). AGENTS.md is an additive
 * fallback: the project's own .goodvibes/GOODVIBES.md keeps precedence when
 * both are present, and every loaded file is listed in the returned source
 * provenance.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findNearestAgentsFile,
  loadSystemPromptWithSources,
} from '../packages/sdk/src/platform/utils/prompt-loader.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-agents-md-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// A home directory with no instruction files, so tests isolate project sources.
function emptyHome(): string {
  return makeTempRoot();
}

describe('findNearestAgentsFile', () => {
  it('returns the closest AGENTS.md walking upward (nearest-file-wins)', () => {
    const root = makeTempRoot();
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root-level');
    writeFileSync(join(root, 'a', 'AGENTS.md'), 'nearer');

    // From c, the nearest AGENTS.md on the way up is a/AGENTS.md, not root.
    expect(findNearestAgentsFile(nested)).toBe(join(root, 'a', 'AGENTS.md'));
  });

  it('returns null when no AGENTS.md exists on the way up', () => {
    const root = makeTempRoot();
    const nested = join(root, 'x', 'y');
    mkdirSync(nested, { recursive: true });
    expect(findNearestAgentsFile(nested)).toBe(null);
  });
});

describe('loadSystemPromptWithSources — AGENTS.md', () => {
  it('loads the nearest AGENTS.md and lists it in the source provenance', () => {
    const home = emptyHome();
    const work = makeTempRoot();
    writeFileSync(join(work, 'AGENTS.md'), 'agent conventions here');

    const result = loadSystemPromptWithSources({
      workingDirectory: work,
      homeDirectory: home,
      argv: [],
    });

    expect(result.prompt).toContain('agent conventions here');
    const agentsSource = result.sources.find((s) => s.kind === 'agents');
    expect(agentsSource).toBeDefined();
    expect(agentsSource?.path).toBe(join(work, 'AGENTS.md'));
  });

  it('keeps the project GOODVIBES.md after AGENTS.md so the project file wins', () => {
    const home = emptyHome();
    const work = makeTempRoot();
    mkdirSync(join(work, '.goodvibes'), { recursive: true });
    writeFileSync(join(work, 'AGENTS.md'), 'AGENTS-BLOCK');
    writeFileSync(join(work, '.goodvibes', 'GOODVIBES.md'), 'PROJECT-BLOCK');

    const result = loadSystemPromptWithSources({
      workingDirectory: work,
      homeDirectory: home,
      argv: [],
    });

    const kinds = result.sources.map((s) => s.kind);
    expect(kinds).toEqual(['agents', 'project']);
    // Later source wins the append order → project block comes after AGENTS.
    expect(result.prompt.indexOf('AGENTS-BLOCK')).toBeLessThan(
      result.prompt.indexOf('PROJECT-BLOCK'),
    );
  });

  it('omits an AGENTS source when no AGENTS.md exists', () => {
    const home = emptyHome();
    const work = makeTempRoot();
    mkdirSync(join(work, '.goodvibes'), { recursive: true });
    writeFileSync(join(work, '.goodvibes', 'GOODVIBES.md'), 'PROJECT-ONLY');

    const result = loadSystemPromptWithSources({
      workingDirectory: work,
      homeDirectory: home,
      argv: [],
    });

    expect(result.sources.some((s) => s.kind === 'agents')).toBe(false);
    expect(result.sources.map((s) => s.kind)).toEqual(['project']);
  });

  it('a --system-prompt-file arg stays exclusive and does not pull in AGENTS.md', () => {
    const home = emptyHome();
    const work = makeTempRoot();
    writeFileSync(join(work, 'AGENTS.md'), 'AGENTS-BLOCK');
    const cliFile = join(work, 'explicit.md');
    writeFileSync(cliFile, 'EXPLICIT');

    const result = loadSystemPromptWithSources({
      workingDirectory: work,
      homeDirectory: home,
      argv: ['--system-prompt-file', cliFile],
    });

    expect(result.prompt).toBe('EXPLICIT');
    expect(result.sources.map((s) => s.kind)).toEqual(['cli']);
  });
});
