import { describe, expect, test } from 'bun:test';
import { evaluateSmokeOutput, runPostBuildSmoke, scanArtifactForEagerNamespaceReads, captureLogger } from '@pellux/goodvibes-toolchain';
import { scriptedExec } from './_helpers.ts';

const config = { bannerPrefix: 'goodvibes-agent ', forbiddenStrings: ['sqlite-vec', '$bunfs/root'], binaryDefault: 'dist/goodvibes-agent' };

const CLEAN_ARTIFACT = [
  'var exports_bootstrap = {};',
  '__export(exports_bootstrap, {',
  '  saveSession: () => saveSession,',
  '});',
  'var init_thing = __esm(() => {',
  '  var lazy = exports_bootstrap.saveSession;', // indented: runs post-settle, safe
  '});',
].join('\n');

const TAINTED_ARTIFACT = `${CLEAN_ARTIFACT}\nvar saveSession2 = exports_bootstrap.saveSession;\nvar buildUrl2 = exports_transport.buildUrl;`;

describe('post-build-smoke', () => {
  test('passes on a correct banner', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr: '' }, config).ok).toBe(true);
  });
  test('fails on a non-zero exit', () => {
    expect(evaluateSmokeOutput({ status: 1, stdout: '', stderr: 'boom' }, config).ok).toBe(false);
  });
  test('fails on a packaging sentinel', () => {
    const r = evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.0.0', stderr: 'cannot find sqlite-vec' }, config);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('sqlite-vec');
  });
  test('fails on a wrong banner prefix', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'v1.0.0', stderr: '' }, config).ok).toBe(false);
  });
  test('runPostBuildSmoke wires exec + banner check', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    expect(runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => CLEAN_ARTIFACT }).ok).toBe(true);
  });
  test('scan flags only column-0 eager namespace reads', () => {
    expect(scanArtifactForEagerNamespaceReads(CLEAN_ARTIFACT)).toEqual([]);
    expect(scanArtifactForEagerNamespaceReads(TAINTED_ARTIFACT)).toEqual([
      'var saveSession2 = exports_bootstrap.saveSession',
      'var buildUrl2 = exports_transport.buildUrl',
    ]);
  });
  test('scan caps its report at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `var alias${i} = exports_shell.member${i};`).join('\n');
    expect(scanArtifactForEagerNamespaceReads(many)).toHaveLength(8);
  });
  test('a booting binary still fails when the artifact carries eager reads', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const logger = captureLogger();
    const r = runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger, readArtifact: () => TAINTED_ARTIFACT });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('eager namespace read');
    expect(r.detail).toContain('exports_bootstrap.saveSession');
  });
  test('an unreadable artifact fails the smoke rather than skipping the scan', () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const r = runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => { throw new Error('EACCES'); } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('artifact scan could not read');
  });
});
