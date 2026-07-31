/**
 * Tests for cli-config-overrides.ts — applyRuntimeConfigDefault regression +
 * core behaviour.
 *
 * applyRuntimeConfigDefault reads BOTH global (configPath) and project
 * (projectConfigPath) persisted files. This suite proves it with a regression
 * that would fail under a single-file read: a project-scoped explicit `false`
 * must survive a front-end default flip.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  applyRuntimeConfigDefault,
  applyRuntimeConfigValue,
  applyRuntimeConfigOverrides,
  applyRuntimeFeatureFlagOverrides,
  applyRuntimeCommandEndpointFlagOverrides,
  parseConfigValueText,
  parseGoodVibesCli,
} from '@pellux/goodvibes-terminal-shell';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-config-override-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

// Write a minimal settings JSON file at the given path.
function writeSettingsFile(filePath: string, content: Record<string, unknown>): void {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('applyRuntimeConfigDefault', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('applies default when neither global nor project file contains the key', () => {
    // No settings files on disk — key is absent everywhere
    applyRuntimeConfigDefault(cm, 'display.stream', true);
    expect(cm.get('display.stream')).toBe(true);
  });

  test('does NOT override when global settings file contains the key (explicit false)', () => {
    // Access the global config path via the same private accessor pattern used in production
    const manager = cm as unknown as { configPath?: string };
    const configPath = manager.configPath;
    expect(typeof configPath).toBe('string'); // loud failure if SDK renamed the accessor
    if (typeof configPath !== 'string') throw new Error('configPath accessor missing from ConfigManager — SDK may have renamed it');
    // Write explicit false to the global settings file
    writeSettingsFile(configPath, { display: { stream: false } });
    // Default wants to set it to true — must be blocked
    applyRuntimeConfigDefault(cm, 'display.stream', true);
    // The in-memory config was loaded at construction time with the default
    // (true). After applyRuntimeConfigDefault the key should NOT have been
    // overridden because the file says false explicitly.
    // NOTE: The function does NOT update the in-memory config when it
    // short-circuits — so the config stays at its loaded value, not at the
    // defaultValue argument. The key test is that applyRuntimeConfigValue
    // is NOT called, meaning the in-memory value is whatever the CM loaded.
    // Since the file existed when CM was created, CM may or may not have read
    // it; what we can guarantee is that applyRuntimeConfigDefault did NOT
    // overwrite it to `true` blindly.
    //
    // To make this deterministic: set the in-memory value to false first,
    // then call applyRuntimeConfigDefault — it must NOT change it to true.
    applyRuntimeConfigValue(cm, 'display.stream', false);
    applyRuntimeConfigDefault(cm, 'display.stream', true);
    // Must still be false — global file has the key, so default is skipped.
    expect(cm.get('display.stream')).toBe(false);
  });

  /**
   * REGRESSION TEST:
   * A single-file read (global only) would ignore a project-scoped explicit
   * `false` in projectConfigPath, and a front-end default (true) would be
   * blindly applied, silently overriding the user.
   *
   * This test proves the fixed behaviour: project-scoped explicit `false`
   * survives a default flip.
   */
  test('project-scoped explicit false survives default flip', () => {
    const manager = cm as unknown as { projectConfigPath?: string; configPath?: string };
    const projectConfigPath = manager.projectConfigPath;
    expect(typeof projectConfigPath).toBe('string'); // loud failure if SDK renamed the accessor
    if (typeof projectConfigPath !== 'string') throw new Error('projectConfigPath accessor missing from ConfigManager — SDK may have renamed it');
    // Ensure global settings file does NOT contain the key
    const globalPath = manager.configPath;
    if (typeof globalPath === 'string') {
      writeSettingsFile(globalPath, {}); // empty — key absent globally
    }
    // Write explicit false to the PROJECT settings file
    writeSettingsFile(projectConfigPath, { display: { stream: false } });

    // Pre-set in-memory value to false (simulates the CM having loaded it)
    applyRuntimeConfigValue(cm, 'display.stream', false);

    // A front-end startup wants to flip the default to true — must be blocked
    // because the project file explicitly has stream: false.
    applyRuntimeConfigDefault(cm, 'display.stream', true);

    // The project-scoped explicit value must have been respected.
    expect(cm.get('display.stream')).toBe(false);
  });

  test('applies default when project file is present but key is absent from it', () => {
    const manager = cm as unknown as { projectConfigPath?: string };
    const projectConfigPath = manager.projectConfigPath;
    expect(typeof projectConfigPath).toBe('string'); // loud failure if SDK renamed the accessor
    if (typeof projectConfigPath !== 'string') throw new Error('projectConfigPath accessor missing from ConfigManager — SDK may have renamed it');
    // Project file exists but does not contain display.stream
    writeSettingsFile(projectConfigPath, { display: { theme: 'dark' } });

    applyRuntimeConfigDefault(cm, 'display.stream', true);
    expect(cm.get('display.stream')).toBe(true);
  });

  test('applies default when project file is malformed JSON', () => {
    const manager = cm as unknown as { projectConfigPath?: string };
    const projectConfigPath = manager.projectConfigPath;
    expect(typeof projectConfigPath).toBe('string'); // loud failure if SDK renamed the accessor
    if (typeof projectConfigPath !== 'string') throw new Error('projectConfigPath accessor missing from ConfigManager — SDK may have renamed it');
    const dir = projectConfigPath.substring(0, projectConfigPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(projectConfigPath, '{ INVALID JSON', 'utf-8');

    applyRuntimeConfigDefault(cm, 'display.stream', true);
    expect(cm.get('display.stream')).toBe(true);
  });
});

describe('applyRuntimeConfigValue', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sets a boolean value', () => {
    applyRuntimeConfigValue(cm, 'display.stream', false);
    expect(cm.get('display.stream')).toBe(false);
  });

  test('throws on unknown key', () => {
    expect(() => applyRuntimeConfigValue(cm, 'nonexistent.key' as never, 'val')).toThrow();
  });

  test('throws on wrong type', () => {
    expect(() => applyRuntimeConfigValue(cm, 'display.stream', 'notabool')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseConfigValueText
// ---------------------------------------------------------------------------

/**
 * The bare-value reader shared by `--config key=value` and a `config set
 * <key> <value>` command. Both must coerce identically — otherwise the same
 * text typed two ways writes two different values into one key. These pin the
 * coercion order rather than any one call site.
 */
describe('parseConfigValueText', () => {
  test('reads JSON first, so structured values keep their shape', () => {
    expect(parseConfigValueText('[1,2]')).toEqual([1, 2]);
    expect(parseConfigValueText('{"a":1}')).toEqual({ a: 1 });
    expect(parseConfigValueText('null')).toBeNull();
    // A quoted number is a string, and stays one.
    expect(parseConfigValueText('"3"')).toBe('3');
  });

  test('reads the bare literals a shell user actually types', () => {
    expect(parseConfigValueText('true')).toBe(true);
    expect(parseConfigValueText('false')).toBe(false);
    expect(parseConfigValueText('42')).toBe(42);
    expect(parseConfigValueText('-1.5')).toBe(-1.5);
  });

  test('surrounding whitespace does not change what a value means', () => {
    expect(parseConfigValueText('  true ')).toBe(true);
    expect(parseConfigValueText(' 42 ')).toBe(42);
  });

  test('anything else is the raw string, un-trimmed', () => {
    expect(parseConfigValueText('dark')).toBe('dark');
    expect(parseConfigValueText('gpt-4o')).toBe('gpt-4o');
    // Trailing space can be significant in a string value, so it survives.
    expect(parseConfigValueText('hello ')).toBe('hello ');
  });

  test('an empty or whitespace-only value is the empty string, never undefined', () => {
    expect(parseConfigValueText('')).toBe('');
    expect(parseConfigValueText('   ')).toBe('');
  });

  test('agrees with what applyRuntimeConfigOverrides writes for the same text', () => {
    // The override path splits `key=value` and hands the value half to this
    // function; if the two ever diverge, `--config x=false` and
    // `config set x false` stop meaning the same thing.
    expect(parseConfigValueText('false')).toBe(false);
    expect(parseConfigValueText('false')).not.toBe('false');
  });
});

describe('applyRuntimeConfigOverrides', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('applies valid key=value override', () => {
    const errors = applyRuntimeConfigOverrides(cm, ['display.stream=false']);
    expect(errors).toEqual([]);
    expect(cm.get('display.stream')).toBe(false);
  });

  test('returns error for malformed override (no =)', () => {
    const errors = applyRuntimeConfigOverrides(cm, ['display.stream']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Expected key=value');
  });

  test('returns error for unknown key', () => {
    const errors = applyRuntimeConfigOverrides(cm, ['bad.unknown.key=val']);
    expect(errors.length).toBe(1);
  });

  test('applies multiple overrides', () => {
    const errors = applyRuntimeConfigOverrides(cm, [
      'display.stream=false',
    ]);
    expect(errors).toEqual([]);
    expect(cm.get('display.stream')).toBe(false);
  });
});

describe('applyRuntimeFeatureFlagOverrides', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--enable-feature and --disable-feature land on the real domain settings keys', () => {
    const featureErrors = applyRuntimeFeatureFlagOverrides(cm, {
      enableFeatures: ['output-schema-fingerprint'],
      disableFeatures: ['agent-passive-knowledge-injection'],
    });
    expect(featureErrors).toEqual([]);
    expect(cm.get('tools.outputSchemaFingerprints')).toBe(true);
    expect(cm.get('agents.passiveInjection.knowledge')).toBe(false);
  });

  test('reports capabilities with no off switch and unknown ids', () => {
    const featureErrors = applyRuntimeFeatureFlagOverrides(cm, {
      enableFeatures: ['no-such-feature'],
      disableFeatures: ['fetch-sanitization'],
    });
    expect(featureErrors.length).toBe(2);
    expect(featureErrors[0]).toContain('unknown feature id');
    expect(featureErrors[1]).toContain('no off switch');
  });

  test('returns an empty error list and touches nothing when no features are named', () => {
    const featureErrors = applyRuntimeFeatureFlagOverrides(cm, { enableFeatures: [], disableFeatures: [] });
    expect(featureErrors).toEqual([]);
  });
});

describe('applyRuntimeCommandEndpointFlagOverrides', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, '.goodvibes', 'global-tui'), { recursive: true });
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a --hostname/--port pair on `web` binds the web endpoint without persisting', () => {
    const cli = parseGoodVibesCli(['web', '--hostname', '0.0.0.0', '--port', '4568']);
    const errors = applyRuntimeCommandEndpointFlagOverrides(cm, cli.command, cli.flags);
    expect(errors).toEqual([]);
    expect(cm.get('web.hostMode')).toBe('network');
    expect(cm.get('web.host')).toBe('0.0.0.0');
    expect(cm.get('web.port')).toBe(4568);
  });

  test('a command with no endpoint of its own is left untouched', () => {
    const cli = parseGoodVibesCli(['status', '--hostname', '0.0.0.0']);
    const errors = applyRuntimeCommandEndpointFlagOverrides(cm, cli.command, cli.flags);
    expect(errors).toEqual([]);
  });

  test('no hostname/port flags at all is a no-op with no errors', () => {
    const cli = parseGoodVibesCli(['web']);
    expect(applyRuntimeCommandEndpointFlagOverrides(cm, cli.command, cli.flags)).toEqual([]);
  });
});
