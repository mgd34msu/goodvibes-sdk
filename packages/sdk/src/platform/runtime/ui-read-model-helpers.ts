import type { RuntimeServices } from './services.js';
import type { UiReadModel } from './ui-read-models-base.js';

export function combineSubscriptions(...teardowns: Array<() => void>): () => void {
  return () => {
    for (const teardown of teardowns) {
      teardown();
    }
  };
}

export function createStoreBackedReadModel<TSnapshot>(
  runtimeServices: RuntimeServices,
  getSnapshot: () => TSnapshot,
): UiReadModel<TSnapshot> {
  return {
    getSnapshot,
    subscribe(listener) {
      return runtimeServices.runtimeStore.subscribe(listener);
    },
  };
}

export function projectRecords<T>(
  ids: readonly string[],
  map: ReadonlyMap<string, T>,
  compare?: (a: T, b: T) => number,
): T[] {
  const items = ids.map((id) => map.get(id)).filter((v): v is T => v !== undefined);
  return compare ? items.sort(compare) : items;
}

export function projectValues<T>(
  map: ReadonlyMap<string, T>,
  compare?: (a: T, b: T) => number,
): T[] {
  const items = [...map.values()];
  return compare ? items.sort(compare) : items;
}

export function listProviderIds(runtimeServices: RuntimeServices): readonly string[] {
  const providerIds = new Set<string>(
    runtimeServices.providerRegistry.listProviders().map((provider) => provider.name),
  );
  for (const model of runtimeServices.providerRegistry.listModels()) {
    providerIds.add(model.provider);
  }
  return [...providerIds].sort();
}
