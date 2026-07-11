/**
 * search-tools-read-deny-enforcement.test.ts
 *
 * The shipped credential deny-read defaults gate the read tool. This suite pins
 * that search / list / map tools (find content = grep, find files = glob, and
 * repo_map) honor the SAME per-file read decision, so a file whose read is
 * restricted never leaks its CONTENT through a search, while path-only listings
 * still show the path marked access-restricted.
 *
 * Coverage:
 *   1. PermissionManager.previewReadAccess: a shipped-credential path is
 *      restricted in prompt mode and allowed in allow-all mode (permission
 *      settings stay the sole authority; the credential default is overridable).
 *   2. find content mode: a restricted file's match text is excluded and the
 *      withheld count is surfaced; allow-all returns it.
 *   3. find files mode: a restricted file's path is listed but flagged
 *      access_restricted, with the withheld count surfaced.
 *   4. repo_map: a restricted file keeps its ranked path but its exported
 *      symbols are withheld and the line is flagged.
 *   5. The frozen catastrophic exec block is untouched, and the credential
 *      defaults are ordinary overridable managed rules (not that frozen list).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager, type PermissionConfigReader } from '../packages/sdk/src/platform/permissions/manager.js';
import type { PolicyRuntimeState } from '../packages/sdk/src/platform/runtime/permissions/policy-runtime.js';
import type { PermissionMode } from '../packages/sdk/src/platform/config/schema.js';
import { SHIPPED_CREDENTIAL_READ_RULES } from '../packages/sdk/src/platform/permissions/credential-read-defaults.js';
import { createFindTool } from '../packages/sdk/src/platform/tools/find/executor.js';
import { createRepoMapTool } from '../packages/sdk/src/platform/tools/repo-map/index.js';
import type { ReadAccessFilter } from '../packages/sdk/src/platform/tools/shared/read-access.js';
import { guardExecCommand } from '../packages/sdk/src/platform/tools/exec/ast-guard.js';
import { ALL_COMMAND_CLASSES } from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

// ── PermissionManager harness ────────────────────────────────────────────────

function makeConfigReader(mode: PermissionMode): PermissionConfigReader {
  return {
    isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/tmp/search-deny-tests',
    getSnapshot: () => ({ permissions: { mode, backgroundAgents: 'inherit', tools: {} } }),
  } as unknown as PermissionConfigReader;
}

function makePolicyRuntimeState(): Pick<PolicyRuntimeState, 'recordPermissionRequest' | 'recordPermissionDecision' | 'getRegistry'> {
  return {
    recordPermissionRequest: () => {},
    recordPermissionDecision: () => {},
    getRegistry: () => ({ getCurrent: () => undefined }) as unknown as ReturnType<PolicyRuntimeState['getRegistry']>,
  };
}

function makeManager(mode: PermissionMode): PermissionManager {
  return new PermissionManager(
    async () => ({ approved: false, remember: false }),
    makeConfigReader(mode),
    makePolicyRuntimeState(),
    null,
    null,
  );
}

const CREDENTIAL_PATH = '/home/someone/.ssh/id_rsa';
const NORMAL_PATH = '/home/someone/project/src/index.ts';

describe('previewReadAccess — the read decision search tools reuse', () => {
  test('prompt mode restricts a shipped-credential path but allows a normal file', () => {
    const manager = makeManager('prompt');
    expect(manager.previewReadAccess(CREDENTIAL_PATH)).toBe('restricted');
    expect(manager.previewReadAccess(NORMAL_PATH)).toBe('allow');
  });

  test('allow-all mode returns the credential path (permission settings are the sole authority)', () => {
    const manager = makeManager('allow-all');
    expect(manager.previewReadAccess(CREDENTIAL_PATH)).toBe('allow');
  });
});

// ── find tool: content (grep) + files (glob) ─────────────────────────────────

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'search-deny-'));
  writeFileSync(join(work, 'public.txt'), 'line one\nSECRETMARK here\nline three\n');
  writeFileSync(join(work, 'secret.txt'), 'nothing\nSECRETMARK here too\nmore\n');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Restrict any file whose absolute path ends with `secret.txt`. */
const restrictSecret: ReadAccessFilter = (abs) => !abs.endsWith('secret.txt');

async function runFind(tool: ReturnType<typeof createFindTool>, query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await tool.execute({ queries: [{ id: 'q', ...query }] });
  expect(res.success).toBe(true);
  const parsed = JSON.parse(res.output as string) as Record<string, unknown>;
  return parsed['q'] as Record<string, unknown>;
}

describe('find content mode (grep) — restricted file content is excluded', () => {
  test('a restricted file contributes no match text and the withheld count is surfaced', async () => {
    const tool = createFindTool(work, null, undefined, restrictSecret);
    const result = await runFind(tool, { mode: 'content', pattern: 'SECRETMARK', path: '.' });
    const matches = (result.matches as Array<{ file: string }>) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => !m.file.endsWith('secret.txt'))).toBe(true);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted file'))).toBe(true);
  });

  test('with no filter (allow-all), the same file is returned', async () => {
    const tool = createFindTool(work, null, undefined, undefined);
    const result = await runFind(tool, { mode: 'content', pattern: 'SECRETMARK', path: '.' });
    const matches = (result.matches as Array<{ file: string }>) ?? [];
    expect(matches.some((m) => m.file.endsWith('secret.txt'))).toBe(true);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted'))).toBe(false);
  });
});

describe('find files mode (glob) — restricted path is listed but flagged', () => {
  test('the restricted path is present and marked access_restricted, with a withheld count', async () => {
    const tool = createFindTool(work, null, undefined, restrictSecret);
    const result = await runFind(tool, { mode: 'files', patterns: ['**/*.txt'], path: '.' });
    const files = (result.files as string[]) ?? [];
    expect(files.some((f) => f.endsWith('secret.txt'))).toBe(true); // existence not hidden
    const restricted = (result.access_restricted as string[]) ?? [];
    expect(restricted.some((f) => f.endsWith('secret.txt'))).toBe(true);
    expect(restricted.some((f) => f.endsWith('public.txt'))).toBe(false);
    const warnings = (result.warnings as string[]) ?? [];
    expect(warnings.some((w) => w.includes('access-restricted file'))).toBe(true);
  });

  test('with no filter, nothing is marked restricted', async () => {
    const tool = createFindTool(work, null, undefined, undefined);
    const result = await runFind(tool, { mode: 'files', patterns: ['**/*.txt'], path: '.' });
    expect(result.access_restricted).toBeUndefined();
  });
});

// ── repo_map ─────────────────────────────────────────────────────────────────

describe('repo_map — restricted file keeps its path but withholds exports', () => {
  let mapRoot: string;

  beforeAll(() => {
    mapRoot = mkdtempSync(join(tmpdir(), 'search-deny-map-'));
    mkdirSync(join(mapRoot, 'src'), { recursive: true });
    writeFileSync(join(mapRoot, 'src', 'consumer.ts'), "import { core } from './core.js';\nexport const consumer = core;\n");
    writeFileSync(join(mapRoot, 'src', 'core.ts'), 'export const core = 1;\nexport function coreFn() { return core; }\n');
  });

  afterAll(() => {
    rmSync(mapRoot, { recursive: true, force: true });
  });

  test('restricted file is flagged and its exported symbols are withheld', async () => {
    const restrictCore: ReadAccessFilter = (abs) => !abs.endsWith(join('src', 'core.ts'));
    const tool = createRepoMapTool({ projectRoot: mapRoot, readAccessFilter: restrictCore });
    const res = await tool.execute({});
    expect(res.success).toBe(true);
    const output = res.output as string;
    expect(output).toContain('core.ts');
    expect(output).toContain('[access-restricted]');
    expect(output).not.toContain('exports: core');
    expect(output).toContain('access-restricted file');
  });

  test('with no filter, the same file exposes its exports', async () => {
    const tool = createRepoMapTool({ projectRoot: mapRoot });
    const res = await tool.execute({});
    const output = res.output as string;
    expect(output).toContain('exports: core');
    expect(output).not.toContain('[access-restricted]');
  });
});

// ── frozen catastrophic block is untouched ───────────────────────────────────

describe('the frozen catastrophic exec block is untouched', () => {
  test('rm -rf / stays unconditionally denied even with all command classes permitted', async () => {
    const result = await guardExecCommand('rm -rf /', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(false);
  });

  test('the credential read defaults are ordinary overridable managed deny rules', () => {
    for (const rule of SHIPPED_CREDENTIAL_READ_RULES) {
      expect(rule.origin).toBe('managed');
      expect(rule.effect).toBe('deny');
    }
  });
});
