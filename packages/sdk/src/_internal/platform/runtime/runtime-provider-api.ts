import { createProviderApi, type ProviderApi } from '../providers/provider-api.js';
import type { RuntimeServices } from './services.js';

export interface RuntimeProviderApiServices extends Pick<
  RuntimeServices,
  'benchmarkStore' | 'favoritesStore' | 'providerRegistry'
> {}

export function createRuntimeProviderApi(
  runtimeServices: RuntimeProviderApiServices,
): ProviderApi {
  return createProviderApi({
    providerRegistry: runtimeServices.providerRegistry,
    favoritesStore: runtimeServices.favoritesStore,
    benchmarkStore: runtimeServices.benchmarkStore,
  });
}

