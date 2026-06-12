import { describe, expect, test } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

function tempDir(label: string): string {
  const dir = join(tmpdir(), `gv-path-${label}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ConfigManager path accessors', () => {
  test('getConfigPath() returns the settings.json path inside configDir', () => {
    const configDir = tempDir('config-path');
    try {
      const mgr = new ConfigManager({ configDir });
      const configPath = mgr.getConfigPath();

      expect(typeof configPath).toBe('string');
      expect(configPath).toEndWith('settings.json');
      expect(configPath).toContain(configDir);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('getProjectConfigPath() returns undefined when no workingDir was provided', () => {
    const configDir = tempDir('no-working-dir');
    try {
      const mgr = new ConfigManager({ configDir });
      expect(mgr.getProjectConfigPath()).toBeUndefined();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('getProjectConfigPath() returns a path ending in settings.json when workingDir is provided', () => {
    const homeDir = tempDir('home');
    const workingDir = tempDir('working');
    try {
      const mgr = new ConfigManager({
        homeDir,
        workingDir,
        surfaceRoot: 'cli',
      });
      const projectPath = mgr.getProjectConfigPath();

      expect(typeof projectPath).toBe('string');
      expect(projectPath).toEndWith('settings.json');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test('getConfigPath() returns an absolute path', () => {
    const configDir = tempDir('abs-path');
    try {
      const mgr = new ConfigManager({ configDir });
      const configPath = mgr.getConfigPath();

      // node:path isAbsolute check
      expect(isAbsolute(configPath)).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('getConfigPath() is consistent with getControlPlaneConfigDir()', () => {
    const configDir = tempDir('consistency');
    try {
      const mgr = new ConfigManager({ configDir });
      const cpDir = mgr.getControlPlaneConfigDir();
      const cfgPath = mgr.getConfigPath();

      // The config path must be inside the control plane config dir
      expect(cfgPath.startsWith(cpDir)).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('getProjectConfigPath() is a distinct path from getConfigPath()', () => {
    const homeDir = tempDir('home2');
    const workingDir = tempDir('working2');
    try {
      const mgr = new ConfigManager({
        homeDir,
        workingDir,
        surfaceRoot: 'cli',
      });
      const globalPath = mgr.getConfigPath();
      const projectPath = mgr.getProjectConfigPath();

      expect(projectPath).toBeDefined();
      expect(projectPath).not.toBe(globalPath);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
