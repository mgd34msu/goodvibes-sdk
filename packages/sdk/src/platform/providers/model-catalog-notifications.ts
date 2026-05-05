import { logger } from '../utils/logger.js';
import type { FavoritesData } from './favorites.js';
import type { CatalogDiff, CatalogModel } from './model-catalog.js';

function catalogRegistryKey(model: CatalogModel): string {
  return `${model.providerId}:${model.id}`;
}

export function diffCatalogs(
  oldCatalog: readonly CatalogModel[],
  newCatalog: readonly CatalogModel[],
): CatalogDiff {
  const oldMap = new Map<string, CatalogModel>(oldCatalog.map((model) => [catalogRegistryKey(model), model]));
  const newMap = new Map<string, CatalogModel>(newCatalog.map((model) => [catalogRegistryKey(model), model]));

  const added: CatalogModel[] = [];
  const removed: CatalogModel[] = [];
  const changed: { model: CatalogModel; changes: string[] }[] = [];

  for (const [id, model] of newMap) {
    if (!oldMap.has(id)) added.push(model);
  }

  for (const [id, model] of oldMap) {
    if (!newMap.has(id)) removed.push(model);
  }

  for (const [id, oldModel] of oldMap) {
    const nextModel = newMap.get(id);
    if (!nextModel) continue;

    const changes: string[] = [];
    if (oldModel.contextWindow !== nextModel.contextWindow) {
      const format = (value?: number) => (value != null ? `${Math.round(value / 1024)}K` : 'unknown');
      changes.push(`context ${format(oldModel.contextWindow)} -> ${format(nextModel.contextWindow)}`);
    }
    if (oldModel.pricing.input !== nextModel.pricing.input) {
      changes.push(`input price $${oldModel.pricing.input} -> $${nextModel.pricing.input} per 1M tokens`);
    }
    if (oldModel.pricing.output !== nextModel.pricing.output) {
      changes.push(`output price $${oldModel.pricing.output} -> $${nextModel.pricing.output} per 1M tokens`);
    }
    if (oldModel.tier !== nextModel.tier) {
      changes.push(`tier ${oldModel.tier} -> ${nextModel.tier}`);
    }
    if (changes.length > 0) {
      changed.push({ model: nextModel, changes });
    }
  }

  return { added, removed, changed };
}

export function filterRelevantChanges(
  diff: CatalogDiff,
  favorites: FavoritesData,
  topBenchmarkModelIds: readonly string[],
): CatalogDiff {
  const relevantRegistryKeys = new Set<string>();
  for (const entry of favorites.history) relevantRegistryKeys.add(entry.registryKey);
  for (const entry of favorites.pinned) relevantRegistryKeys.add(entry.registryKey);
  const topBenchmarkIds = new Set(topBenchmarkModelIds);

  const isRelevant = (model: CatalogModel) =>
    relevantRegistryKeys.has(`${model.providerId}:${model.id}`) || topBenchmarkIds.has(model.id);
  return {
    added: diff.added.filter(isRelevant),
    removed: diff.removed.filter(isRelevant),
    changed: diff.changed.filter((entry) => isRelevant(entry.model)),
  };
}

export function formatChangeNotifications(diff: CatalogDiff): string[] {
  const notifications: string[] = [];
  for (const model of diff.added) {
    notifications.push(`New model: ${model.name} now available on ${model.provider}`);
  }
  for (const { model, changes } of diff.changed) {
    for (const change of changes) {
      notifications.push(`Model update: ${model.name} ${change}`);
    }
  }
  for (const model of diff.removed) {
    notifications.push(`Model removed: ${model.name} no longer available on ${model.provider}`);
  }
  return notifications;
}

export function notifyCatalogChanges(
  oldModels: readonly CatalogModel[],
  newModels: readonly CatalogModel[],
  favorites: FavoritesData,
  topBenchmarkModelIds: readonly string[],
): string[] {
  const diff = diffCatalogs(oldModels, newModels);
  const filtered = filterRelevantChanges(diff, favorites, topBenchmarkModelIds);
  const notifications = formatChangeNotifications(filtered);
  for (const message of notifications) {
    logger.info(`[model-catalog] ${message}`);
  }
  return notifications;
}
