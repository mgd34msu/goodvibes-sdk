/**
 * prune-stale-operator-tokens.test.ts
 *
 * Unit tests for F3 (SDK 0.21.36) — `pruneStaleOperatorTokens`. Exercises:
 *   - Canonical-absent path: returns `absentPaths` for every candidate, prunes nothing.
 *   - Candidate-absent path: reported in `absentPaths`.
 *   - Candidate-matches-canonical: reported in `matchedPaths`, file preserved.
 *   - Candidate-differs-from-canonical: reported in `prunedPaths`, file removed.
 *   - Self-reference defense: candidate equal to canonical is skipped.
 *   - Malformed candidate JSON: `readTokenFromPath` returns null ≠ canonical → pruned.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleOperatorTokens } from '../packages/sdk/src/_internal/platform/pairing/companion-token.js';

function writeToken(path: string, token: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ token, peerId: 'peer-test', createdAt: Date.now() }), { encoding: 'utf-8' });
}

describe('pruneStaleOperatorTokens', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-prune-token-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('canonical absent → canonicalToken: null, absentPaths lists every candidate, prunes nothing', () => {
    // No file at <daemonHomeDir>/operator-tokens.json.
    const daemonHomeDir = join(root, 'daemon');
    const candidateA = join(root, 'ws', '.goodvibes', 'operator-tokens.json');
    const candidateB = join(root, 'ws', '.goodvibes', 'tui', 'operator-tokens.json');
    writeToken(candidateA, 'gv_stale_a');
    writeToken(candidateB, 'gv_stale_b');

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [candidateA, candidateB],
    });

    expect(result.canonicalToken).toBeNull();
    expect(result.absentPaths).toEqual([candidateA, candidateB]);
    expect(result.prunedPaths).toEqual([]);
    expect(result.matchedPaths).toEqual([]);
    expect(result.failedPaths).toEqual([]);
    // Candidate files are NOT removed when canonical is missing.
    expect(existsSync(candidateA)).toBe(true);
    expect(existsSync(candidateB)).toBe(true);
  });

  test('candidate path absent → reported in absentPaths', () => {
    const daemonHomeDir = join(root, 'daemon');
    writeToken(join(daemonHomeDir, 'operator-tokens.json'), 'gv_live');
    const missingPath = join(root, 'ws', 'does-not-exist.json');

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [missingPath],
    });

    expect(result.canonicalToken).toBe('gv_live');
    expect(result.absentPaths).toEqual([missingPath]);
    expect(result.prunedPaths).toEqual([]);
    expect(result.matchedPaths).toEqual([]);
  });

  test('candidate token matches canonical → matchedPaths, file preserved', () => {
    const daemonHomeDir = join(root, 'daemon');
    const canonicalPath = join(daemonHomeDir, 'operator-tokens.json');
    const candidatePath = join(root, 'ws', '.goodvibes', 'operator-tokens.json');
    writeToken(canonicalPath, 'gv_live');
    writeToken(candidatePath, 'gv_live'); // same token

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [candidatePath],
    });

    expect(result.canonicalToken).toBe('gv_live');
    expect(result.matchedPaths).toEqual([candidatePath]);
    expect(result.prunedPaths).toEqual([]);
    expect(existsSync(candidatePath)).toBe(true);
  });

  test('candidate token differs from canonical → prunedPaths, file unlinked', () => {
    const daemonHomeDir = join(root, 'daemon');
    const canonicalPath = join(daemonHomeDir, 'operator-tokens.json');
    const candidatePath = join(root, 'ws', '.goodvibes', 'operator-tokens.json');
    writeToken(canonicalPath, 'gv_live');
    writeToken(candidatePath, 'gv_stale');

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [candidatePath],
    });

    expect(result.canonicalToken).toBe('gv_live');
    expect(result.prunedPaths).toEqual([candidatePath]);
    expect(result.matchedPaths).toEqual([]);
    expect(existsSync(candidatePath)).toBe(false);
    // Canonical file is untouched.
    expect(existsSync(canonicalPath)).toBe(true);
  });

  test('candidate path equal to canonical path → silently skipped (no self-delete)', () => {
    const daemonHomeDir = join(root, 'daemon');
    const canonicalPath = join(daemonHomeDir, 'operator-tokens.json');
    writeToken(canonicalPath, 'gv_live');

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [canonicalPath],
    });

    expect(result.prunedPaths).toEqual([]);
    expect(result.matchedPaths).toEqual([]);
    expect(result.absentPaths).toEqual([]);
    expect(existsSync(canonicalPath)).toBe(true);
  });

  test('candidate with malformed JSON → treated as mismatch and pruned', () => {
    const daemonHomeDir = join(root, 'daemon');
    const canonicalPath = join(daemonHomeDir, 'operator-tokens.json');
    const candidatePath = join(root, 'ws', '.goodvibes', 'operator-tokens.json');
    writeToken(canonicalPath, 'gv_live');
    mkdirSync(join(root, 'ws', '.goodvibes'), { recursive: true });
    writeFileSync(candidatePath, '{ not valid json', 'utf-8');

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [candidatePath],
    });

    expect(result.prunedPaths).toEqual([candidatePath]);
    expect(existsSync(candidatePath)).toBe(false);
  });

  test('mixed set: some match, some differ, some absent — each bucketed correctly', () => {
    const daemonHomeDir = join(root, 'daemon');
    writeToken(join(daemonHomeDir, 'operator-tokens.json'), 'gv_live');
    const matchPath = join(root, 'a', 'operator-tokens.json');
    const stalePath = join(root, 'b', 'operator-tokens.json');
    const absentPath = join(root, 'c', 'operator-tokens.json');
    writeToken(matchPath, 'gv_live');
    writeToken(stalePath, 'gv_stale');
    // absentPath intentionally never created

    const result = pruneStaleOperatorTokens({
      daemonHomeDir,
      candidatePaths: [matchPath, stalePath, absentPath],
    });

    expect(result.matchedPaths).toEqual([matchPath]);
    expect(result.prunedPaths).toEqual([stalePath]);
    expect(result.absentPaths).toEqual([absentPath]);
    expect(result.failedPaths).toEqual([]);
    expect(existsSync(matchPath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
  });
});
