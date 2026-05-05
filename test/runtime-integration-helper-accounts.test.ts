import { describe, expect, test } from 'bun:test';
import { AccountsSnapshotResponseSchema } from '../packages/contracts/src/zod-schemas/accounts.js';
import { IntegrationHelperService } from '../packages/sdk/src/platform/runtime/integration/helpers.js';

function createIntegrationHelperService(): IntegrationHelperService {
  return new IntegrationHelperService({
    providerRegistry: {
      listModels: () => [
        { provider: 'test-provider', id: 'test-model' },
        { provider: 'test-provider', id: 'test-model-large' },
      ],
      getCurrentModel: () => ({ provider: 'test-provider', id: 'test-model' }),
      getRegistered: () => [],
      describeRuntime: async (providerId: string) => providerId === 'test-provider'
        ? {
            notes: ['runtime provider note'],
            usage: {
              streaming: true,
              toolCalling: true,
              parallelTools: false,
              notes: ['usage note'],
            },
            policy: {
              notes: ['policy note'],
            },
          }
        : null,
    },
    serviceRegistry: {
      getAll: () => ({
        'test-oauth-service': {
          name: 'test-oauth-service',
          providerId: 'test-provider',
        },
      }),
      inspect: async (name: string) => name === 'test-oauth-service'
        ? {
            config: {
              name,
              providerId: 'test-provider',
              authType: 'oauth',
            },
            hasPrimaryCredential: true,
          }
        : null,
    },
    subscriptionManager: {
      list: () => [],
      listPending: () => [],
      get: () => null,
      getPending: () => null,
    },
    secretsManager: {
      get: async () => null,
    },
  } as never);
}

describe('IntegrationHelperService accounts snapshot', () => {
  test('returns the canonical provider account snapshot without dropping contract fields', async () => {
    const helpers = createIntegrationHelperService();

    const snapshot = await helpers.getAccountsSnapshot();
    const parsed = AccountsSnapshotResponseSchema.parse(snapshot);
    const provider = parsed.providers.find((entry) => entry.providerId === 'test-provider');

    expect(provider).toBeDefined();
    expect(provider?.notes).toEqual(['runtime provider note', 'usage note', 'policy note']);
    expect(provider?.routeRecords).toEqual([{
      route: 'service-oauth',
      usable: true,
      freshness: 'healthy',
      detail: 'Service OAuth credential is available for this provider.',
      issues: [],
    }]);
    expect(provider?.usageWindows).toEqual([]);
    expect(provider?.activeRoute).toBe('service-oauth');
    expect(provider?.active).toBe(true);
  });
});
