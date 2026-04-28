import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import { ToolRegistry } from '../packages/sdk/src/_internal/platform/tools/registry.js';
import {
  appendGoodVibesRuntimeAwarenessPrompt,
  createGoodVibesContextTool,
  createGoodVibesSettingsTool,
} from '../packages/sdk/src/_internal/platform/tools/goodvibes-runtime/index.js';

function makeConfigManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-runtime-tool-'));
  return new ConfigManager({
    configDir: join(root, 'config'),
    homeDir: join(root, 'home'),
    workingDir: join(root, 'workspace'),
    surfaceRoot: 'goodvibes',
  });
}

function makeProviderRegistry() {
  return {
    getCurrentModel: () => ({
      id: 'gpt-5.5',
      provider: 'openai',
      registryKey: 'openai:gpt-5.5',
      displayName: 'GPT-5.5',
    }),
    listProviders: () => [{ name: 'openai' }],
    listModels: () => [{ id: 'gpt-5.5', provider: 'openai', registryKey: 'openai:gpt-5.5' }],
    getConfiguredProviderIds: () => ['openai'],
  };
}

function makeDeps(configManager = makeConfigManager()) {
  return {
    configManager,
    providerRegistry: makeProviderRegistry() as never,
    toolRegistry: new ToolRegistry(),
    workingDirectory: configManager.getWorkingDirectory() ?? '',
    homeDirectory: configManager.getHomeDirectory() ?? '',
    surfaceRoot: 'goodvibes',
  };
}

describe('GoodVibes runtime tools', () => {
  test('goodvibes_context returns redacted settings and never raw secrets', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.homeassistant.accessToken', 'goodvibes://secrets/goodvibes/HASS_TOKEN');
    const tool = createGoodVibesContextTool(makeDeps(configManager));

    const result = await tool.execute({
      mode: 'config_get',
      key: 'surfaces.homeassistant.accessToken',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"redacted": true');
    expect(result.output).not.toContain('HASS_TOKEN');
  });

  test('goodvibes_settings changes normal settings through ConfigManager validation', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'display.theme',
      value: 'midnight',
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(configManager.get('display.theme')).toBe('midnight');
  });

  test('goodvibes_settings refuses raw credential persistence', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'surfaces.slack.botToken',
      value: 'xoxb-raw-token-value',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing to persist a raw credential');
    expect(configManager.get('surfaces.slack.botToken')).toBe('');
  });

  test('runtime awareness prompt tells models to inspect harness state', () => {
    const prompt = appendGoodVibesRuntimeAwarenessPrompt('Base prompt');
    expect(prompt).toContain('goodvibes_context');
    expect(prompt).toContain('Do not spawn agents or WRFC chains');
  });
});
