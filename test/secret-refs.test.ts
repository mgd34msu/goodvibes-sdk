import { describe, expect, test } from 'bun:test';
import {
  getSecretRefSource,
  isSecretRefInput,
  normalizeSecretRef,
  resolveSecretRef,
} from '../packages/sdk/src/platform/config/secret-refs.js';

describe('GoodVibes SecretRef URI syntax', () => {
  test('parses env and local GoodVibes secret refs', () => {
    expect(normalizeSecretRef('goodvibes://secrets/env/OPENAI_API_KEY')).toEqual({
      source: 'env',
      id: 'OPENAI_API_KEY',
    });

    expect(normalizeSecretRef('goodvibes://secrets/goodvibes/OPENAI_API_KEY')).toEqual({
      source: 'goodvibes',
      id: 'OPENAI_API_KEY',
    });

    expect(getSecretRefSource('goodvibes://secrets/goodvibes/OPENAI_API_KEY')).toBe('goodvibes');
  });

  test('parses file refs with home-relative and encoded absolute paths', () => {
    expect(normalizeSecretRef('goodvibes://secrets/file/~/.credentials/key.json?selector=openai.api_key')).toEqual({
      source: 'file',
      path: '~/.credentials/key.json',
      selector: 'openai.api_key',
    });

    expect(normalizeSecretRef('goodvibes://secrets/file/%2Fetc%2Fgoodvibes%2Fkey.json')).toEqual({
      source: 'file',
      path: '/etc/goodvibes/key.json',
      selector: undefined,
    });
  });

  test('parses exec refs with explicit URI args', () => {
    expect(
      normalizeSecretRef(
        'goodvibes://secrets/exec/op?arg=read&arg=op%3A%2F%2FDevelopment%2FOpenAI%2Fapi_key&timeoutMs=5000',
      ),
    ).toMatchObject({
      source: 'exec',
      command: 'op',
      args: ['read', 'op://Development/OpenAI/api_key'],
      timeoutMs: 5000,
    });
  });

  test('parses 1Password refs from query parameters and native refs', () => {
    expect(
      normalizeSecretRef('goodvibes://secrets/1password?vault=Development&item=OpenAI&field=api_key'),
    ).toMatchObject({
      source: '1password',
      vault: 'Development',
      item: 'OpenAI',
      field: 'api_key',
    });

    expect(
      normalizeSecretRef('goodvibes://secrets/op?ref=op%3A%2F%2FDevelopment%2FOpenAI%2Fapi_key'),
    ).toMatchObject({
      source: '1password',
      ref: 'op://Development/OpenAI/api_key',
    });
  });

  test('parses Bitwarden, Vaultwarden, and BWS refs', () => {
    expect(
      normalizeSecretRef(
        'goodvibes://secrets/bitwarden/openai-prod/api_key?customField=ApiKey&server=https%3A%2F%2Fvault.example.com&validateServer=true&syncBeforeRead=false&timeoutMs=5000',
      ),
    ).toMatchObject({
      source: 'bitwarden',
      item: 'openai-prod',
      field: 'api_key',
      customField: 'ApiKey',
      server: 'https://vault.example.com',
      validateServer: true,
      syncBeforeRead: false,
      timeoutMs: 5000,
    });

    expect(normalizeSecretRef('goodvibes://secrets/vaultwarden?item=openai-prod&field=password')).toMatchObject({
      source: 'vaultwarden',
      item: 'openai-prod',
      field: 'password',
    });

    expect(
      normalizeSecretRef('goodvibes://secrets/bws/secret-123?field=value&profile=prod&serverUrl=https%3A%2F%2Fvault.example.com'),
    ).toMatchObject({
      source: 'bws',
      id: 'secret-123',
      field: 'value',
      profile: 'prod',
      serverUrl: 'https://vault.example.com',
    });
  });

  test('rejects the removed generic secret URI scheme', () => {
    expect(isSecretRefInput('secret://env/OPENAI_API_KEY')).toBe(false);
    expect(normalizeSecretRef('secret://bitwarden?item=openai-prod&field=password')).toBeNull();
    expect(normalizeSecretRef('goodvibes://config/env/OPENAI_API_KEY')).toBeNull();
  });

  test('resolves goodvibes URI refs without embedding secret values in the URI', async () => {
    const previous = process.env['GV_SECRET_REF_TEST'];
    process.env['GV_SECRET_REF_TEST'] = 'env-secret-value';
    try {
      expect(await resolveSecretRef('goodvibes://secrets/env/GV_SECRET_REF_TEST')).toEqual({
        source: 'env',
        value: 'env-secret-value',
      });

      expect(
        await resolveSecretRef('goodvibes://secrets/goodvibes/OPENAI_API_KEY', {
          resolveLocalSecret: async (key) => key === 'OPENAI_API_KEY' ? 'local-secret-value' : null,
        }),
      ).toEqual({
        source: 'goodvibes',
        value: 'local-secret-value',
      });
    } finally {
      if (previous === undefined) delete process.env['GV_SECRET_REF_TEST'];
      else process.env['GV_SECRET_REF_TEST'] = previous;
    }
  });
});
